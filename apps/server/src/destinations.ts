import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import pg from "pg"
import { ColumnSpec, TableArtifact, TableArtifactFormat, TableDestination } from "@data-integrator/definitions"

const execFileP = promisify(execFile)

/** Maps a ColumnSpec type to its Postgres column type. */
function pgType(spec: ColumnSpec): string {
  switch (spec.type) {
    case "text":
    case "enum":
      return "text"
    case "number":
      return "double precision"
    case "integer":
      return "bigint"
    case "boolean":
      return "boolean"
    case "date":
      return "date"
    case "datetime":
      return "timestamptz"
    case "geometry":
      return "geometry(Geometry, 4326)"
    case "json":
      return "jsonb"
    default:
      throw new Error(`Unknown column type "${(spec as ColumnSpec).type}" for column ${spec.id}`)
  }
}

/** SQL expression for one bound parameter of a column, converting from the row JSON value. */
function valueExpr(spec: ColumnSpec, placeholder: string): string {
  switch (spec.type) {
    case "geometry":
      return `ST_SetSRID(ST_GeomFromGeoJSON(${placeholder}), 4326)`
    case "json":
      return `${placeholder}::jsonb`
    default:
      return placeholder
  }
}

/** JS value passed as the bound parameter for a column. */
function bindValue(spec: ColumnSpec, value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (spec.type === "geometry" || spec.type === "json") return JSON.stringify(value)
  return value
}

/** Quotes an identifier defensively; ids are slug-validated but quoting costs nothing. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, "")}"`
}

/** Builds the CREATE TABLE DDL plus index statements for a destination. */
function tableDdl(schema: string, tableName: string, spec: TableDestination): string[] {
  const cols = spec.columns.map(c => `${ident(c.id)} ${pgType(c)}`).join(",\n  ")
  const statements = [
    `CREATE TABLE ${ident(schema)}.${ident(tableName)} (
  _id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  _run_id uuid NOT NULL,
  ${cols}
)`
  ]
  for (const c of spec.columns) {
    if (c.type === "geometry") {
      statements.push(
        `CREATE INDEX ${ident(`${tableName}_${c.id}_gist`)} ON ${ident(schema)}.${ident(tableName)} USING GIST (${ident(c.id)})`
      )
    }
  }
  if (spec.action === "merge") {
    const mergeCols = (spec.mergeColumns ?? []).map(ident).join(", ")
    statements.push(
      `CREATE UNIQUE INDEX ${ident(`${tableName}_merge`)} ON ${ident(schema)}.${ident(tableName)} (${mergeCols})`
    )
  }
  return statements
}

/**
 * Creates the destination table if absent, or applies additive evolution (new
 * columns) if present. Type changes and removals are not applied: the old
 * column stays until a replace destination rebuilds the table or an operator
 * alters it by hand.
 */
export async function ensureTable(client: pg.ClientBase, spec: TableDestination, schema = "data"): Promise<void> {
  const existing = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $2 AND table_name = $1`,
    [spec.tableId, schema]
  )
  if (existing.rows.length === 0) {
    for (const statement of tableDdl(schema, spec.tableId, spec)) {
      await client.query(statement)
    }
    return
  }
  const have = new Set(existing.rows.map(r => r.column_name as string))
  for (const c of spec.columns) {
    if (!have.has(c.id)) {
      await client.query(`ALTER TABLE ${ident(schema)}.${ident(spec.tableId)} ADD COLUMN ${ident(c.id)} ${pgType(c)}`)
    }
  }
}

/** Insert chunk size; keeps parameter counts well under the wire limit. */
const CHUNK = 500

/** Inserts rows in chunks, optionally with an ON CONFLICT clause. */
async function insertRows(
  client: pg.ClientBase,
  schema: string,
  tableName: string,
  spec: TableDestination,
  rows: Record<string, unknown>[],
  runId: string,
  onConflict: string
): Promise<void> {
  const colNames = ["_run_id", ...spec.columns.map(c => c.id)].map(ident).join(", ")
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK)
    const params: unknown[] = []
    const tuples = chunk.map(row => {
      const exprs = [
        (params.push(runId), `$${params.length}`),
        ...spec.columns.map(c => {
          params.push(bindValue(c, row[c.id]))
          return valueExpr(c, `$${params.length}`)
        })
      ]
      return `(${exprs.join(", ")})`
    })
    await client.query(
      `INSERT INTO ${ident(schema)}.${ident(tableName)} (${colNames}) VALUES ${tuples.join(", ")}${onConflict}`,
      params
    )
  }
}

/** ON CONFLICT clause implementing the merge action; empty for replace and append. */
function conflictClause(spec: TableDestination): string {
  if (spec.action !== "merge") return ""
  const mergeCols = (spec.mergeColumns ?? []).map(ident).join(", ")
  const updates = ["_run_id", ...spec.columns.filter(c => !(spec.mergeColumns ?? []).includes(c.id)).map(c => c.id)]
    .map(c => `${ident(c)} = EXCLUDED.${ident(c)}`)
    .join(", ")
  return ` ON CONFLICT (${mergeCols}) DO UPDATE SET ${updates}`
}

/**
 * Fills a destination-shaped table with a run's rows under the given ON
 * CONFLICT clause, and reports how many rows landed.
 */
type Fill = (tableName: string, onConflict: string) => Promise<number>

/**
 * Applies one run's output to a destination table per its action, whatever the
 * source of the rows. Runs inside the caller's commit transaction. replace
 * builds a new table and swaps so readers never see a partial load.
 */
async function applyToDestination(
  client: pg.ClientBase,
  spec: TableDestination,
  schema: string,
  fill: Fill
): Promise<number> {
  if (spec.action === "replace") {
    const tmp = `${spec.tableId}__new`
    await client.query(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(tmp)}`)
    for (const statement of tableDdl(schema, tmp, spec)) {
      await client.query(statement)
    }
    const count = await fill(tmp, "")
    await client.query(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(spec.tableId)}`)
    await client.query(`ALTER TABLE ${ident(schema)}.${ident(tmp)} RENAME TO ${ident(spec.tableId)}`)
    // Indexes keep tmp-based names; rename so the next replace does not collide
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $3 AND tablename = $1 AND indexname LIKE $2`,
      [spec.tableId, `${tmp}%`, schema]
    )
    for (const row of indexes.rows) {
      const renamed = (row.indexname as string).replace(tmp, spec.tableId)
      await client.query(`ALTER INDEX ${ident(schema)}.${ident(row.indexname)} RENAME TO ${ident(renamed)}`)
    }
    return count
  }

  if (spec.action === "merge") {
    try {
      return await fill(spec.tableId, conflictClause(spec))
    } catch (err) {
      // A merge whose own output repeats a key cannot be applied row by row
      if ((err as { code?: string }).code === "21000") {
        throw new Error(
          `Table ${spec.tableId}: this run's output has more than one row per ` +
            `${(spec.mergeColumns ?? []).join(", ")}; deduplicate before returning it`
        )
      }
      throw err
    }
  }

  return fill(spec.tableId, "")
}

/**
 * Applies inline rows (RunResult.data) to a destination table. Runs inside the
 * caller's commit transaction.
 */
export async function applyRows(
  client: pg.ClientBase,
  spec: TableDestination,
  rows: Record<string, unknown>[],
  runId: string,
  schema = "data"
): Promise<number> {
  return applyToDestination(client, spec, schema, async (tableName, onConflict) => {
    await insertRows(client, schema, tableName, spec, rows, runId, onConflict)
    return rows.length
  })
}

// ============================================================================
// File loads (RunResult.tables): ogr2ogr into staging, then INSERT ... SELECT
// ============================================================================

/** Schema holding per-run staging tables; deliberately outside the query surface. */
const STAGE_SCHEMA = "stage"

/** Geometry column name ogr2ogr is told to write in staging tables. */
const STAGE_GEOM = "_geom"

/** Staging columns OGR adds itself; never part of what the author's file "has". */
const STAGE_INTERNAL = new Set([STAGE_GEOM, "ogc_fid"])

/** Formats inferred from a table file's extension when the artifact omits one. */
const FORMAT_BY_EXTENSION: Record<string, TableArtifactFormat> = {
  ".geojson": "geojson",
  ".json": "geojson",
  ".fgb": "fgb",
  ".gpkg": "gpkg",
  ".csv": "csv"
}

/** OGR driver per accepted format; passed explicitly so a mislabelled file fails loudly. */
const DRIVER_BY_FORMAT: Record<TableArtifactFormat, string> = {
  geojson: "GeoJSON",
  fgb: "FlatGeobuf",
  gpkg: "GPKG",
  csv: "CSV"
}

/** Postgres types whose values arrive as text and need trimming before a cast. */
const TEXT_UDTS = new Set(["text", "varchar", "bpchar", "char", "name"])

/** Resolves a table artifact's format from its declaration or its extension. */
export function tableFileFormat(artifact: TableArtifact): TableArtifactFormat {
  if (artifact.format) return artifact.format
  const format = FORMAT_BY_EXTENSION[path.extname(artifact.path).toLowerCase()]
  if (!format) {
    throw new Error(
      `Table file "${artifact.path}" for ${artifact.tableId} has no recognized extension; ` +
        `declare format as one of ${Object.values(FORMAT_BY_EXTENSION).join(", ")}`
    )
  }
  return format
}

/** A table file loaded into staging, ready to apply to its destination. */
export interface StagedTable {
  /** Destination the staged rows feed */
  spec: TableDestination
  /** Staging table name within the staging schema */
  table: string
}

/**
 * Loads a table file into a per-run staging table with ogr2ogr. Runs outside
 * the commit transaction (ogr2ogr brings its own connection), which is why the
 * destination is staging rather than the live table: applying the staged rows
 * and swapping the table still happen atomically, in the caller's transaction.
 */
export async function stageTableFile(
  pool: pg.Pool,
  databaseUrl: string,
  spec: TableDestination,
  file: string,
  format: TableArtifactFormat,
  runId: string
): Promise<StagedTable> {
  const layer = await singleLayer(file, spec.tableId)
  const table = `stg_${runId.replace(/-/g, "").slice(0, 8)}_${spec.tableId}`.slice(0, 63)
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(STAGE_SCHEMA)}`).catch((err: { code?: string }) => {
    // IF NOT EXISTS still races two workers creating it at once
    if (err.code !== "23505" && err.code !== "42P06") throw err
  })

  // Bare URI, no "PG:" prefix, postgresql:// scheme: see materializeTable
  await execFileP("ogr2ogr", [
    "-f", "PostgreSQL",
    databaseUrl.replace(/^postgres:\/\//, "postgresql://"),
    file,
    layer,
    "-if", DRIVER_BY_FORMAT[format],
    "-nln", `${STAGE_SCHEMA}.${table}`,
    "-lco", `GEOMETRY_NAME=${STAGE_GEOM}`,
    "-lco", "SPATIAL_INDEX=NONE",
    "-overwrite",
    "--config", "PG_USE_COPY", "YES"
  ]).catch(err => {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(`Table ${spec.tableId}: loading ${format} file failed: ${detail.slice(-500)}`)
  })
  return { spec, table }
}

/** Drops a staging table; cleanup is best-effort and never fails a run. */
export async function dropStagedTable(pool: pg.Pool, staged: StagedTable): Promise<void> {
  await pool
    .query(`DROP TABLE IF EXISTS ${ident(STAGE_SCHEMA)}.${ident(staged.table)}`)
    .catch(() => {})
}

/**
 * Drops staging tables belonging to no running run: what a worker killed
 * mid-load leaves behind. Staging names carry the owning run's id prefix, so
 * ownership needs no bookkeeping of its own.
 */
export async function dropOrphanStagedTables(pool: pg.Pool): Promise<number> {
  const staged = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    [STAGE_SCHEMA]
  )
  if (staged.rows.length === 0) return 0
  const running = await pool.query(
    `SELECT substr(replace(id::text, '-', ''), 1, 8) AS prefix FROM app.runs WHERE status = 'running'`
  )
  const live = new Set(running.rows.map(r => r.prefix as string))
  let dropped = 0
  for (const row of staged.rows) {
    const name = row.table_name as string
    const prefix = /^stg_([0-9a-f]{8})_/.exec(name)?.[1]
    if (prefix && live.has(prefix)) continue
    await pool.query(`DROP TABLE IF EXISTS ${ident(STAGE_SCHEMA)}.${ident(name)}`)
    dropped++
  }
  return dropped
}

/**
 * Applies a staged file load to its destination per the destination's action,
 * inside the caller's commit transaction. The declared columns stay the
 * contract: staging fields are matched by name (plus the file's geometry for a
 * declared geometry column) and cast to the declared types.
 */
export async function applyStagedTable(
  client: pg.ClientBase,
  staged: StagedTable,
  runId: string,
  schema = "data"
): Promise<number> {
  const { spec } = staged
  const staging = await client.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [STAGE_SCHEMA, staged.table]
  )
  const types = new Map(staging.rows.map(r => [r.column_name as string, r.udt_name as string]))
  const geometryFields = staging.rows.filter(r => r.udt_name === "geometry").map(r => r.column_name as string)

  const exprs = spec.columns.map(column => {
    const source = sourceColumn(column, types, geometryFields, spec.tableId)
    return stagedValueExpr(column, `s.${ident(source)}`, types.get(source)!)
  })
  const colNames = ["_run_id", ...spec.columns.map(c => c.id)].map(ident).join(", ")

  return applyToDestination(client, spec, schema, async (tableName, onConflict) => {
    const result = await client.query(
      `INSERT INTO ${ident(schema)}.${ident(tableName)} (${colNames})
       SELECT $1, ${exprs.join(", ")} FROM ${ident(STAGE_SCHEMA)}.${ident(staged.table)} s${onConflict}`,
      [runId]
    )
    return result.rowCount ?? 0
  })
}

/** Picks the staging column feeding a declared column, or explains what is missing. */
function sourceColumn(
  column: ColumnSpec,
  types: Map<string, string>,
  geometryFields: string[],
  tableId: string
): string {
  if (types.has(column.id)) return column.id
  // The file's geometry needs no matching name: OGR names it by driver convention
  if (column.type === "geometry" && geometryFields.length === 1) return geometryFields[0]
  const available = [...types.keys()].filter(name => !STAGE_INTERNAL.has(name)).join(", ")
  throw new Error(
    `Table ${tableId}: file has no column "${column.id}"${
      column.type === "geometry" && geometryFields.length > 1 ? " and more than one geometry column" : ""
    }. File columns: ${available || "(none)"}`
  )
}

/** SQL expression converting one staging column to a declared column's type. */
function stagedValueExpr(column: ColumnSpec, source: string, sourceUdt: string): string {
  const fromText = TEXT_UDTS.has(sourceUdt)
  const trimmed = `NULLIF(btrim(${source}), '')`
  if (column.type === "geometry") {
    if (sourceUdt === "geometry") {
      // Files carry their own CRS; the destination column is always 4326
      return `CASE ST_SRID(${source}) WHEN 0 THEN ST_SetSRID(${source}, 4326)
        WHEN 4326 THEN ${source} ELSE ST_Transform(${source}, 4326) END`
    }
    return `ST_SetSRID(ST_GeomFromGeoJSON(${fromText ? trimmed : `${source}::text`}), 4326)`
  }
  if (column.type === "text" || column.type === "enum") return `${source}::text`
  const target = pgType(column)
  return `${fromText ? trimmed : source}::${target}`
}

/** The single layer of a table file; multi-layer files are ambiguous, not supported. */
async function singleLayer(file: string, tableId: string): Promise<string> {
  const { stdout } = await execFileP("ogrinfo", ["-q", file]).catch(err => {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(`Table ${tableId}: cannot read table file: ${detail.slice(-500)}`)
  })
  // "1: layer_name (Polygon)", geometry type absent for non-spatial layers
  const names = stdout
    .split("\n")
    .map(line => /^\s*\d+:\s*(.+?)(?:\s+\([^)]*\))?\s*$/.exec(line)?.[1])
    .filter((name): name is string => !!name)
  if (names.length === 0) throw new Error(`Table ${tableId}: table file has no layers`)
  if (names.length > 1) {
    throw new Error(
      `Table ${tableId}: table file has ${names.length} layers (${names.join(", ")}); write one layer per file`
    )
  }
  return names[0]
}

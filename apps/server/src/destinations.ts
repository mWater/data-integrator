import pg from "pg"
import { ColumnSpec, TableDestination } from "@data-integrator/definitions"

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
 * columns) if present. Type changes and removals are rejected; those rebuild
 * via the replace action or a manual migration.
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

/**
 * Applies a run's rows to a destination table per its action. Runs inside the
 * caller's commit transaction. replace builds a new table and swaps so readers
 * never see a partial load.
 */
export async function applyRows(
  client: pg.ClientBase,
  spec: TableDestination,
  rows: Record<string, unknown>[],
  runId: string,
  schema = "data"
): Promise<number> {
  if (spec.action === "replace") {
    const tmp = `${spec.tableId}__new`
    await client.query(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(tmp)}`)
    for (const statement of tableDdl(schema, tmp, spec)) {
      await client.query(statement)
    }
    await insertRows(client, schema, tmp, spec, rows, runId, "")
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
    return rows.length
  }

  if (spec.action === "merge") {
    const mergeCols = (spec.mergeColumns ?? []).map(ident).join(", ")
    const updates = ["_run_id", ...spec.columns.filter(c => !(spec.mergeColumns ?? []).includes(c.id)).map(c => c.id)]
      .map(c => `${ident(c)} = EXCLUDED.${ident(c)}`)
      .join(", ")
    await insertRows(client, schema, spec.tableId, spec, rows, runId, ` ON CONFLICT (${mergeCols}) DO UPDATE SET ${updates}`)
    return rows.length
  }

  await insertRows(client, schema, spec.tableId, spec, rows, runId, "")
  return rows.length
}

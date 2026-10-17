import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { copyFile, link, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import {
  FilterSpec,
  InManifest,
  InManifestInput,
  InManifestSnapshot,
  IntegrationDefinition,
  RasterInputRef,
  TableInputRef
} from "@data-integrator/definitions"
import { RasterStore } from "./rasterStore.js"
import { snapshotSources } from "./catalog.js"
import { FileStore } from "./fileStore.js"
import { materializeFiles, ResolvedFiles } from "./files.js"

const execFileP = promisify(execFile)

/** Published-identifier rule; extract SQL only ever quotes ids that match it. */
const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Row cap for table extracts; larger extracts must narrow with `where`. */
const EXTRACT_MAX_ROWS = 500_000

/** What the materializer needs from its host. */
export interface MaterializeDeps {
  /** App/data database pool */
  pool: pg.Pool
  /** Raster store holding snapshot COGs */
  store: RasterStore
  /** Connection URL for ogr2ogr (gpkg extracts) */
  databaseUrl: string
  /** Store holding uploaded file versions; needed only when files are materialized */
  files?: FileStore
}

/**
 * Materializes a definition's inputs, and the resolved file versions, into
 * inDir and writes /in/manifest.json. Returns the manifest (also recorded on
 * the run for lineage).
 */
export async function materializeInputs(
  deps: MaterializeDeps,
  definition: IntegrationDefinition,
  inDir: string,
  files: ResolvedFiles = {}
): Promise<InManifest> {
  const manifest: InManifest = { inputs: {} }
  if (Object.keys(files).length > 0) {
    if (!deps.files) throw new Error("This run reads uploaded files but no file store is configured")
    manifest.files = await materializeFiles(deps.files, inDir, files)
  }
  for (const [inputId, ref] of Object.entries(definition.inputs ?? {})) {
    if (!ID_PATTERN.test(inputId)) throw new Error(`Invalid input id: ${inputId}`)
    manifest.inputs[inputId] =
      ref.kind === "raster"
        ? await materializeRaster(deps, inputId, ref, inDir)
        : await materializeTable(deps, inputId, ref, definition.runtime, inDir)
  }
  await writeFile(path.join(inDir, "manifest.json"), JSON.stringify(manifest, null, 2))
  return manifest
}

/**
 * Materializes the selected snapshots of a layer under /in/<inputId>/: a
 * single-file snapshot as its COG, a multi-file snapshot as its files plus a
 * VRT over them (the manifest path), an empty snapshot as a manifest entry
 * with no path.
 */
async function materializeRaster(
  deps: MaterializeDeps,
  inputId: string,
  ref: RasterInputRef,
  inDir: string
): Promise<InManifestInput> {
  const layer = await deps.pool.query("SELECT id FROM app.raster_layers WHERE id = $1", [ref.layerId])
  if (layer.rows.length === 0) throw new Error(`Input ${inputId}: unknown layer ${ref.layerId}`)

  // Duplicate observed_at (a republished period) resolves to the newest snapshot
  const base = `SELECT DISTINCT ON (observed_at) id, observed_at, observed_end, bands
                FROM app.raster_snapshots WHERE layer_id = $1 AND status = 'promoted'`
  let result
  if (ref.select === "current") {
    result = await deps.pool.query(
      `SELECT s.id, s.observed_at, s.observed_end, s.bands
       FROM app.raster_layers l JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       WHERE l.id = $1`,
      [ref.layerId]
    )
  } else if ("latest" in ref.select) {
    const picked = await deps.pool.query(
      `SELECT * FROM (${base} ORDER BY observed_at DESC, created_at DESC) newest
       ORDER BY observed_at DESC LIMIT $2`,
      [ref.layerId, ref.select.latest]
    )
    result = { rows: picked.rows.reverse() }
  } else {
    result = await deps.pool.query(
      `${base} AND observed_at >= $2 AND observed_at <= COALESCE($3, 'infinity'::timestamptz)
       ORDER BY observed_at, created_at DESC`,
      [ref.layerId, ref.select.from, ref.select.to ?? null]
    )
  }

  const dir = path.join(inDir, inputId)
  await mkdir(dir, { recursive: true })
  const snapshots: InManifestSnapshot[] = []
  for (const row of result.rows) {
    const timestamp = row.observed_at.toISOString()
    const stem = timestamp.replace(/:/g, "-")
    const sources = await snapshotSources(deps.pool, row.id)
    let manifestPath: string | null = null
    if (sources.length === 1) {
      await linkOrCopy(deps.store.absolute(sources[0].path), path.join(dir, `${stem}.tif`))
      manifestPath = `${inputId}/${stem}.tif`
    } else if (sources.length > 1) {
      await mkdir(path.join(dir, stem), { recursive: true })
      const files: string[] = []
      for (const [ordinal, source] of sources.entries()) {
        await linkOrCopy(deps.store.absolute(source.path), path.join(dir, stem, `${ordinal}.tif`))
        files.push(`${stem}/${ordinal}.tif`)
      }
      // Relative arguments from the VRT's own directory keep the VRT
      // relocatable: it resolves inside the container at /in as written here
      await execFileP("gdalbuildvrt", ["-q", `${stem}.vrt`, ...files], { cwd: dir })
      manifestPath = `${inputId}/${stem}.vrt`
    }
    snapshots.push({
      path: manifestPath,
      snapshotId: row.id,
      timestamp,
      timestampEnd: row.observed_end ? row.observed_end.toISOString() : undefined,
      bands: row.bands
    })
  }
  return { kind: "raster", layerId: ref.layerId, snapshots }
}

/** Extracts a table to /in/<inputId>.<ext> in the requested format. */
async function materializeTable(
  deps: MaterializeDeps,
  inputId: string,
  ref: TableInputRef,
  runtime: IntegrationDefinition["runtime"],
  inDir: string
): Promise<InManifestInput> {
  if (!ID_PATTERN.test(ref.tableId)) throw new Error(`Input ${inputId}: invalid tableId ${ref.tableId}`)
  const format = ref.format ?? (runtime === "python" ? "gpkg" : "json")

  const columns = await tableColumns(deps.pool, ref.tableId)
  if (columns.length === 0) throw new Error(`Input ${inputId}: table ${ref.tableId} does not exist (has it run yet?)`)
  const selected = ref.columns ?? columns.filter(c => c.name !== "_id" && c.name !== "_run_id").map(c => c.name)
  for (const name of selected) {
    if (!columns.some(c => c.name === name)) throw new Error(`Input ${inputId}: no column ${name} in ${ref.tableId}`)
  }
  const geometryColumns = new Set(columns.filter(c => c.isGeometry).map(c => c.name))

  const { whereSql, params, whereLiteral } = buildWhere(ref.where ?? [], columns)

  const countResult = await deps.pool.query(
    `SELECT count(*) AS n FROM data."${ref.tableId}"${whereSql ? ` WHERE ${whereSql}` : ""}`,
    params
  )
  const rowCount = Number(countResult.rows[0].n)
  if (rowCount > EXTRACT_MAX_ROWS) {
    throw new Error(`Input ${inputId}: extract has ${rowCount} rows (cap ${EXTRACT_MAX_ROWS}); narrow it with "where"`)
  }

  const fileName = `${inputId}.${format}`
  const target = path.join(inDir, fileName)

  if (format === "gpkg") {
    const selectList = selected.map(name => `"${name}"`).join(", ")
    // Bare URI, no "PG:" prefix: GDAL appends application_name to prefixed
    // strings, which corrupts URI-style conninfo. GDAL only recognizes the
    // postgresql:// spelling of the scheme.
    await execFileP("ogr2ogr", [
      "-f", "GPKG", target,
      deps.databaseUrl.replace(/^postgres:\/\//, "postgresql://"),
      "-sql", `SELECT ${selectList} FROM data."${ref.tableId}"${whereLiteral ? ` WHERE ${whereLiteral}` : ""}`,
      "-nln", inputId
    ])
  } else {
    const dateColumns = new Set(columns.filter(c => c.isDate).map(c => c.name))
    const selectList = selected
      .map(name => {
        if (geometryColumns.has(name)) return `ST_AsGeoJSON("${name}")::json AS "${name}"`
        if (dateColumns.has(name)) return `"${name}"::text AS "${name}"`
        return `"${name}"`
      })
      .join(", ")
    const rows = await deps.pool.query(
      `SELECT ${selectList} FROM data."${ref.tableId}"${whereSql ? ` WHERE ${whereSql}` : ""} ORDER BY 1`,
      params
    )
    await writeFile(target, format === "json" ? JSON.stringify(rows.rows) : toCsv(selected, rows.rows))
  }

  return { kind: "table", tableId: ref.tableId, path: fileName, format, rowCount }
}

/** One column of a data table as the extractor sees it. */
export interface ColumnInfo {
  /** Column name */
  name: string
  /** True for PostGIS geometry columns (serialized as GeoJSON in json/csv) */
  isGeometry: boolean
  /** True for bare-date columns (read as text, or the driver timezone-shifts them) */
  isDate: boolean
}

/** Columns of a data-schema table; empty when the table does not exist. */
export async function tableColumns(pool: pg.Pool, tableId: string): Promise<ColumnInfo[]> {
  const result = await pool.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'data' AND table_name = $1 ORDER BY ordinal_position`,
    [tableId]
  )
  return result.rows.map(row => ({
    name: row.column_name,
    isGeometry: row.udt_name === "geometry",
    isDate: row.udt_name === "date"
  }))
}

/**
 * Builds the WHERE clause twice: parameterized (for pool queries) and as
 * safe literals (for ogr2ogr, which cannot take bound parameters).
 */
export function buildWhere(
  where: FilterSpec,
  columns: ColumnInfo[]
): { whereSql: string; params: unknown[]; whereLiteral: string } {
  const OPS = ["=", "!=", ">", ">=", "<", "<=", "in"]
  const sqlParts: string[] = []
  const literalParts: string[] = []
  const params: unknown[] = []
  for (const clause of where) {
    if (!columns.some(c => c.name === clause.column)) throw new Error(`Filter references unknown column ${clause.column}`)
    if (!OPS.includes(clause.op)) throw new Error(`Unsupported filter op ${clause.op}`)
    if (clause.op === "in") {
      const values = Array.isArray(clause.value) ? clause.value : [clause.value]
      params.push(values)
      sqlParts.push(`"${clause.column}" = ANY($${params.length})`)
      literalParts.push(`"${clause.column}" IN (${values.map(literal).join(", ")})`)
    } else {
      params.push(clause.value)
      sqlParts.push(`"${clause.column}" ${clause.op} $${params.length}`)
      literalParts.push(`"${clause.column}" ${clause.op} ${literal(clause.value)}`)
    }
  }
  return { whereSql: sqlParts.join(" AND "), params, whereLiteral: literalParts.join(" AND ") }
}

/** SQL literal for a filter value (numbers, booleans, null, else quoted text). */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Minimal CSV writer; geometry objects become GeoJSON strings. */
function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return ""
    const text =
      value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.join(",")]
  for (const row of rows) lines.push(columns.map(name => cell(row[name])).join(","))
  return lines.join("\n") + "\n"
}

/** Hardlinks a file into place, copying when the store is on another filesystem. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to)
  } catch {
    await copyFile(from, to)
  }
}

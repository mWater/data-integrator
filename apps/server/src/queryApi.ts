import pg from "pg"
import { LocalizedString, ColumnSpec, FilterSpec } from "@data-integrator/definitions"
import { buildWhere, tableColumns } from "./materialize.js"

/** Hard cap on rows per request; page with limit/offset beyond it. */
const MAX_LIMIT = 10_000

/** Default rows per request. */
const DEFAULT_LIMIT = 1000

/** One table of the harmonized dataset as the API describes it. */
export interface TableInfo {
  /** Table id (the name under /api/tables) */
  tableId: string
  /** Integration that writes it */
  integrationId: string
  /** Display name from the destination spec */
  name?: LocalizedString
  /** Catalog description from the destination spec */
  description?: LocalizedString
  /** Declared column specs (names, types, units, enums) */
  columns: ColumnSpec[]
}

/** A rows query parsed from the request. */
export interface RowsQuery {
  /** Columns to return; absent = all data columns */
  columns?: string[]
  /** Row filter (FilterSpec, same vocabulary as definition inputs) */
  where?: FilterSpec
  /** Sort: column name, optionally suffixed .desc */
  order?: string
  /** Max rows (capped) */
  limit?: number
  /** Skip rows for paging */
  offset?: number
}

/** Result of a rows query. */
export interface RowsResult {
  /** Column names in result order */
  columns: string[]
  /** The rows; geometry cells are GeoJSON objects */
  rows: Record<string, unknown>[]
  /** Names of geometry columns (for geojson rendering) */
  geometryColumns: string[]
}

/** Lists the queryable tables with their declared schemas. */
export async function listTables(pool: pg.Pool): Promise<TableInfo[]> {
  const result = await pool.query("SELECT id, integration_id, spec FROM app.data_tables ORDER BY id")
  return result.rows.map(row => ({
    tableId: row.id,
    integrationId: row.integration_id,
    name: row.spec?.name,
    description: row.spec?.description,
    columns: (row.spec?.columns as ColumnSpec[]) ?? []
  }))
}

/**
 * Runs one filtered read over a data table. Read-only, statement-timeout
 * bound, row-capped. Throws Error with a client-safe message on bad input;
 * returns null when the table does not exist.
 */
export async function queryRows(pool: pg.Pool, tableId: string, query: RowsQuery): Promise<RowsResult | null> {
  const columns = await tableColumns(pool, tableId)
  if (columns.length === 0) return null

  const dataColumns = columns.filter(c => c.name !== "_id" && c.name !== "_run_id")
  const selected = query.columns ?? dataColumns.map(c => c.name)
  for (const name of selected) {
    if (!dataColumns.some(c => c.name === name)) throw new Error(`No column ${name} in ${tableId}`)
  }
  const geometryColumns = dataColumns.filter(c => c.isGeometry).map(c => c.name)

  const dateColumns = dataColumns.filter(c => c.isDate).map(c => c.name)
  const selectList = selected
    .map(name => {
      if (geometryColumns.includes(name)) return `ST_AsGeoJSON("${name}")::json AS "${name}"`
      if (dateColumns.includes(name)) return `"${name}"::text AS "${name}"`
      return `"${name}"`
    })
    .join(", ")
  const { whereSql, params } = buildWhere(query.where ?? [], columns)

  let orderSql = `"_id"`
  if (query.order) {
    const desc = query.order.endsWith(".desc")
    const column = desc ? query.order.slice(0, -5) : query.order.replace(/\.asc$/, "")
    if (!dataColumns.some(c => c.name === column)) throw new Error(`No column ${column} to order by`)
    orderSql = `"${column}"${desc ? " DESC" : ""}`
  }
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const offset = Math.max(0, query.offset ?? 0)

  const client = await pool.connect()
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query("SET LOCAL statement_timeout = '30s'")
    const result = await client.query(
      `SELECT ${selectList} FROM data."${tableId}"${whereSql ? ` WHERE ${whereSql}` : ""}
       ORDER BY ${orderSql} LIMIT ${limit} OFFSET ${offset}`,
      params
    )
    return { columns: selected, rows: result.rows, geometryColumns }
  } finally {
    await client.query("ROLLBACK").catch(() => {})
    client.release()
  }
}

/** Renders a rows result as CSV text. */
export function rowsToCsv(result: RowsResult): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return ""
    const text =
      value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [result.columns.join(",")]
  for (const row of result.rows) lines.push(result.columns.map(name => cell(row[name])).join(","))
  return lines.join("\n") + "\n"
}

/**
 * Renders a rows result as a GeoJSON FeatureCollection using the first
 * geometry column; remaining columns become feature properties.
 */
export function rowsToGeoJson(result: RowsResult): object {
  const geometryColumn = result.geometryColumns.find(name => result.columns.includes(name))
  if (!geometryColumn) throw new Error("Table has no geometry column selected; use format=json or csv")
  return {
    type: "FeatureCollection",
    features: result.rows.map(row => ({
      type: "Feature",
      geometry: row[geometryColumn] ?? null,
      properties: Object.fromEntries(
        result.columns.filter(name => name !== geometryColumn).map(name => [name, row[name]])
      )
    }))
  }
}

/** Parses a rows query from URL search params. Throws on malformed input. */
export function parseRowsQuery(params: URLSearchParams): RowsQuery {
  const query: RowsQuery = {}
  const columns = params.get("columns")
  if (columns) query.columns = columns.split(",").map(s => s.trim())
  const where = params.get("where")
  if (where) {
    const parsed = JSON.parse(where)
    query.where = Array.isArray(parsed) ? parsed : [parsed]
  }
  const order = params.get("order")
  if (order) query.order = order
  const limit = params.get("limit")
  if (limit) {
    query.limit = Number(limit)
    if (!Number.isInteger(query.limit)) throw new Error("limit must be a whole number")
  }
  const offset = params.get("offset")
  if (offset) {
    query.offset = Number(offset)
    if (!Number.isInteger(query.offset) || query.offset < 0) throw new Error("offset must be a whole number, at least 0")
  }
  return query
}

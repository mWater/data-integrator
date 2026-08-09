/**
 * Stored dashboard queries: frozen at design time, executed with typed bound
 * parameters under the sql_engine role (SELECT on data only). Viewers never
 * send SQL; they name a query and supply parameter values.
 */

import pg from "pg"

/** Absolute row cap; per-query maxRows may only lower it. */
const MAX_ROWS = 10_000

/** Default per-query row cap. */
const DEFAULT_MAX_ROWS = 5000

/** Statement timeout for stored-query execution. */
const TIMEOUT = "15s"

/** Hard cap on one encoded vector tile; oversized tiles mean missing LOD. */
const MAX_TILE_BYTES = 2 * 1024 * 1024

/** MVT extent (coordinate space per tile, the de facto standard). */
const MVT_EXTENT = 4096

/** MVT clip buffer in extent units; the envelope filter margin matches it. */
const MVT_BUFFER = 64

/** Highest tile zoom served; deeper requests are client overzoom. */
const MAX_TILE_ZOOM = 24

/**
 * Reserved tile-query parameter: the server binds the tile zoom level to it so
 * frozen SQL can vary level of detail (aggregate at low zoom, raw rows deep).
 */
export const ZOOM_PARAM = "zoom"

/** Value types a query parameter may declare. */
export type QueryParamType = "text" | "number" | "integer" | "boolean" | "date" | "datetime"

/** One declared parameter of a stored query. */
export interface QueryParamSpec {
  /** Parameter name; the SQL references it positionally ($1..$n in declaration order). */
  name: string
  /** Value type; values are validated against it before binding. */
  type: QueryParamType
  /** Rejects null/absent values when true. */
  required?: boolean
}

/** One stored query of a dashboard. */
export interface DashboardQuery {
  /** Name the dashboard's useQuery() calls reference. */
  name: string
  /** Single SELECT (or WITH) statement; $1..$n bind params in declaration order. */
  sql: string
  /** Declared parameters in positional order. */
  params: QueryParamSpec[]
  /** Row cap for this query; capped at the absolute maximum. */
  maxRows?: number
  /**
   * Tile query: serves MVT vector tiles instead of rows. The SQL must select a
   * geometry column named "geom" (SRID 4326); the server wraps it per tile with
   * an envelope filter, clip, and MVT encoding. Row caps do not apply; a byte
   * cap per tile does.
   */
  tile?: boolean
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const PARAM_TYPES: QueryParamType[] = ["text", "number", "integer", "boolean", "date", "datetime"]

/** Validates a query list shape; returns error messages (empty = valid). */
export function validateQueries(queries: DashboardQuery[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const q of queries) {
    if (!q || typeof q !== "object") {
      errors.push("query entries must be objects")
      continue
    }
    if (typeof q.name !== "string" || !NAME_PATTERN.test(q.name)) {
      errors.push(`query name ${JSON.stringify(q.name)} must match ${NAME_PATTERN}`)
    } else if (seen.has(q.name)) {
      errors.push(`duplicate query name ${q.name}`)
    } else {
      seen.add(q.name)
    }
    if (typeof q.sql !== "string" || q.sql.trim() === "") errors.push(`query ${q.name}: sql is required`)
    if (!Array.isArray(q.params)) {
      errors.push(`query ${q.name}: params must be an array`)
      continue
    }
    for (const p of q.params) {
      if (typeof p?.name !== "string" || !NAME_PATTERN.test(p.name))
        errors.push(`query ${q.name}: bad param name ${JSON.stringify(p?.name)}`)
      if (!PARAM_TYPES.includes(p?.type)) errors.push(`query ${q.name}: bad param type ${JSON.stringify(p?.type)}`)
    }
    if (q.maxRows != null && (!Number.isInteger(q.maxRows) || q.maxRows < 1))
      errors.push(`query ${q.name}: maxRows must be a positive integer`)
    if (q.tile != null && typeof q.tile !== "boolean") errors.push(`query ${q.name}: tile must be a boolean`)
    if (q.tile === true) {
      const zoom = q.params.find((p) => p?.name === ZOOM_PARAM)
      if (zoom && zoom.type !== "integer")
        errors.push(`query ${q.name}: the reserved "${ZOOM_PARAM}" parameter must have type integer`)
      if (zoom?.required)
        errors.push(`query ${q.name}: the reserved "${ZOOM_PARAM}" parameter is server-bound; drop required`)
    }
  }
  return errors
}

function coerceParam(spec: QueryParamSpec, value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    if (spec.required) throw new Error(`parameter ${spec.name} is required`)
    return null
  }
  switch (spec.type) {
    case "text":
      if (typeof value !== "string") throw new Error(`parameter ${spec.name} must be a string`)
      return value
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`parameter ${spec.name} must be a number`)
      return value
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        throw new Error(`parameter ${spec.name} must be an integer`)
      return value
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`parameter ${spec.name} must be a boolean`)
      return value
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error(`parameter ${spec.name} must be a YYYY-MM-DD date`)
      return value
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
        throw new Error(`parameter ${spec.name} must be an ISO 8601 datetime`)
      return value
  }
}

/** Runs one statement read-only as sql_engine with the standard guards. */
async function runAsSqlEngine(pool: pg.Pool, sql: string, bound: unknown[]): Promise<pg.QueryResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query("SET LOCAL ROLE sql_engine")
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}'`)
    // public is on the path for extension functions (PostGIS); table access
    // still requires grants, and sql_engine has none outside data
    await client.query("SET LOCAL search_path = data, public")
    return await client.query(sql, bound)
  } finally {
    await client.query("ROLLBACK").catch(() => {})
    client.release()
  }
}

/**
 * Executes a stored query with the given named parameter values. Runs read-only
 * as sql_engine with a statement timeout; errors carry client-safe messages.
 */
export async function executeStoredQuery(
  pool: pg.Pool,
  query: DashboardQuery,
  values: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const bound = query.params.map((spec) => coerceParam(spec, values[spec.name]))
  const cap = Math.min(query.maxRows ?? DEFAULT_MAX_ROWS, MAX_ROWS)
  const sql = query.sql.trim().replace(/;+\s*$/, "")

  const result = await runAsSqlEngine(pool, `SELECT * FROM (${sql}) _q LIMIT ${cap + 1}`, bound)
  if (result.rows.length > cap)
    throw new Error(`query ${query.name} exceeds ${cap} rows; aggregate or add a filter`)
  return result.rows
}

/**
 * Executes a tile query for one slippy tile, returning encoded MVT bytes
 * (empty when the tile has no features). The frozen SQL is wrapped per tile:
 * an envelope intersection filter (pushed into the query, so spatial indexes
 * apply), ST_AsMVTGeom clipping, and ST_AsMVT encoding under the query's name
 * as the tile layer. The reserved "zoom" parameter is bound to z server-side.
 */
export async function executeTileQuery(
  pool: pg.Pool,
  query: DashboardQuery,
  values: Record<string, unknown>,
  z: number,
  x: number,
  y: number
): Promise<Buffer> {
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) throw new Error(`bad tile zoom ${z}`)
  if (!Number.isInteger(x) || x < 0 || x >= 2 ** z || !Number.isInteger(y) || y < 0 || y >= 2 ** z)
    throw new Error(`bad tile coordinates ${z}/${x}/${y}`)

  const bound = query.params.map((spec) =>
    spec.name === ZOOM_PARAM ? z : coerceParam(spec, values[spec.name])
  )
  const sql = query.sql.trim().replace(/;+\s*$/, "")
  // The envelope filter margin matches the MVT clip buffer so edge features
  // render whole across tile seams
  const margin = MVT_BUFFER / MVT_EXTENT
  const n = bound.length
  const env = `ST_TileEnvelope($${n + 1}::int, $${n + 2}::int, $${n + 3}::int)`
  const wrapped = `
    WITH _src AS (${sql})
    SELECT COALESCE(ST_AsMVT(_tile, '${query.name}', ${MVT_EXTENT}, 'geom'), ''::bytea) AS mvt
    FROM (
      SELECT ST_AsMVTGeom(ST_Transform(_src.geom, 3857), ${env}, ${MVT_EXTENT}, ${MVT_BUFFER}, true) AS geom,
             to_jsonb(_src) - 'geom' AS props
      FROM _src
      WHERE _src.geom && ST_Transform(ST_TileEnvelope($${n + 1}::int, $${n + 2}::int, $${n + 3}::int, margin => ${margin}), 4326)
    ) _tile
    WHERE _tile.geom IS NOT NULL`

  let result: pg.QueryResult
  try {
    result = await runAsSqlEngine(pool, wrapped, [...bound, z, x, y])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/column .*geom.* does not exist/i.test(message))
      throw new Error(`tile query ${query.name} must select a geometry column named "geom"`)
    throw err
  }
  const mvt: Buffer = result.rows[0]?.mvt ?? Buffer.alloc(0)
  if (mvt.length > MAX_TILE_BYTES)
    throw new Error(
      `tile ${z}/${x}/${y} of query ${query.name} exceeds ${MAX_TILE_BYTES} bytes; aggregate or thin features at this zoom`
    )
  return mvt
}

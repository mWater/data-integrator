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

  const client = await pool.connect()
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query("SET LOCAL ROLE sql_engine")
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}'`)
    // public is on the path for extension functions (PostGIS); table access
    // still requires grants, and sql_engine has none outside data
    await client.query("SET LOCAL search_path = data, public")
    const result = await client.query(`SELECT * FROM (${sql}) _q LIMIT ${cap + 1}`, bound)
    if (result.rows.length > cap)
      throw new Error(`query ${query.name} exceeds ${cap} rows; aggregate or add a filter`)
    return result.rows
  } finally {
    await client.query("ROLLBACK").catch(() => {})
    client.release()
  }
}

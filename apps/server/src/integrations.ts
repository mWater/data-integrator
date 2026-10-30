import pg from "pg"
import { LocalizedString, IntegrationDefinition } from "@data-integrator/definitions"
import { RunFlag } from "./validation.js"

/** Summary row for the integrations list. */
export interface IntegrationSummary {
  /** Integration id */
  id: string
  /** Display name from the definition */
  name: LocalizedString
  /** What the integration ingests and produces, when the definition has one */
  description: LocalizedString | null
  /** Runtime image id */
  runtime: string
  /** Trigger spec from the definition */
  trigger: unknown
  /** Number of declared destinations */
  destinations: number
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Status of the most recent run, if any */
  lastRunStatus: string | null
  /** Finish (or start) time of the most recent run (ISO) */
  lastRunAt: string | null
}

/** One run row in an integration's history. */
export interface RunSummary {
  /** Run id */
  id: string
  /** What triggered it */
  trigger: string
  /** Terminal or current status */
  status: string
  /** Start time (ISO) */
  startedAt: string | null
  /** Finish time (ISO) */
  finishedAt: string | null
  /** Row/snapshot stats recorded on success */
  stats: unknown
  /** Error message on failure */
  error: string | null
  /** Validation flags the run raised; null when none */
  flags: RunFlag[] | null
}

/** Per-destination stored-data stats. */
export interface DestinationStats {
  /** Destination kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Row count (tables) or promoted snapshot count (rasters); null when absent */
  count: number | null
}

/** Full integration detail. */
export interface IntegrationDetail {
  /** Integration id */
  id: string
  /** Current definition version */
  version: number
  /** Installed definition */
  definition: IntegrationDefinition
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Install/update time (ISO) */
  updatedAt: string
  /** Recent runs, newest first */
  runs: RunSummary[]
  /** Stored-data stats per destination */
  destinations: DestinationStats[]
}

/** Lists installed integrations with their latest run, newest first. */
export async function listIntegrations(pool: pg.Pool): Promise<IntegrationSummary[]> {
  const result = await pool.query(
    `SELECT i.id, i.definition->'name' AS name, i.definition->'description' AS description,
            i.definition->>'runtime' AS runtime,
            i.definition->'trigger' AS trigger,
            COALESCE(jsonb_array_length(i.definition->'destinations'), 0) AS destinations,
            i.enabled, i.status, r.status AS last_status, COALESCE(r.finished_at, r.started_at) AS last_at
     FROM app.integrations i
     LEFT JOIN LATERAL (
       SELECT status, started_at, finished_at FROM app.runs
       WHERE integration_id = i.id ORDER BY scheduled_at DESC LIMIT 1
     ) r ON true
     ORDER BY i.updated_at DESC`
  )
  return result.rows.map(row => ({
    id: row.id,
    name: row.name ?? { _base: "en", en: row.id },
    description: row.description ?? null,
    runtime: row.runtime ?? "?",
    trigger: row.trigger ?? {},
    destinations: row.destinations,
    enabled: row.enabled,
    status: row.status,
    lastRunStatus: row.last_status ?? null,
    lastRunAt: row.last_at ? row.last_at.toISOString() : null
  }))
}

/** Loads one integration with run history and destination stats, or null. */
export async function getIntegration(pool: pg.Pool, id: string): Promise<IntegrationDetail | null> {
  const result = await pool.query(
    "SELECT version, definition, enabled, status, updated_at FROM app.integrations WHERE id = $1",
    [id]
  )
  if (result.rows.length === 0) return null
  const { version, definition, enabled, status, updated_at } = result.rows[0]

  const runs = await pool.query(
    `SELECT id, trigger, status, started_at, finished_at, stats, error, flags
     FROM app.runs WHERE integration_id = $1 ORDER BY scheduled_at DESC LIMIT 50`,
    [id]
  )

  const destinations: DestinationStats[] = []
  for (const dest of (definition as IntegrationDefinition).destinations ?? []) {
    if (dest.kind === "table") {
      // The table only exists after the first run, so probe before counting
      const exists = await pool.query("SELECT to_regclass('data.' || quote_ident($1::text)) IS NOT NULL AS ok", [
        dest.tableId
      ])
      let count: number | null = null
      if (exists.rows[0].ok) {
        const rows = await pool.query(`SELECT count(*) AS count FROM data.${quoteIdent(dest.tableId)}`)
        count = toCount(rows.rows[0].count)
      }
      destinations.push({ kind: "table", id: dest.tableId, count })
    } else {
      const count = await pool.query(
        "SELECT count(*) AS count FROM app.raster_snapshots WHERE layer_id = $1 AND status = 'promoted'",
        [dest.layerId]
      )
      destinations.push({ kind: "raster", id: dest.layerId, count: toCount(count.rows[0]?.count) })
    }
  }

  return {
    id,
    version,
    definition,
    enabled,
    status,
    updatedAt: updated_at.toISOString(),
    runs: runs.rows.map(row => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      stats: row.stats,
      error: row.error,
      flags: row.flags ?? null
    })),
    destinations
  }
}

/** How a definition version answers the area-of-interest question. */
export type AoiMode = "inherit" | "full" | "box"

/** One archived definition version, for the integration's history view. */
export interface VersionSummary {
  /** Version number, counting up from 1 */
  version: number
  /** Archive time (ISO) */
  createdAt: string
  /** Email of the installing user; null for CLI/library-sync installs */
  createdBy: string | null
  /** Display name in this version */
  name: LocalizedString
  /** AOI tri-state in this version */
  aoiMode: AoiMode
  /** The explicit box, when aoiMode is "box" */
  aoi: { bbox: [number, number, number, number]; countries?: string[] } | null
}

/** The version history of an integration, newest first. */
export async function listIntegrationVersions(pool: pg.Pool, id: string): Promise<VersionSummary[]> {
  const result = await pool.query(
    `SELECT v.version, v.created_at, u.email AS created_by, v.definition->'name' AS name,
            v.definition->'aoi' AS aoi, v.definition ? 'aoi' AS has_aoi
     FROM app.integration_versions v
     LEFT JOIN app.users u ON u.id = v.created_by
     WHERE v.integration_id = $1 ORDER BY v.version DESC`,
    [id]
  )
  return result.rows.map(row => ({
    version: row.version,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by ?? null,
    name: row.name ?? { _base: "en", en: id },
    aoiMode: !row.has_aoi ? "inherit" : row.aoi === null ? "full" : "box",
    aoi: row.has_aoi && row.aoi !== null ? row.aoi : null
  }))
}

/** A table preview: column names plus the most recent rows. */
export interface TablePreview {
  /** Column names in table order (system columns excluded) */
  columns: string[]
  /** Rows, newest first; geometry cells are GeoJSON objects */
  rows: Record<string, unknown>[]
}

/**
 * Returns the newest rows of one of an integration's destination tables, or
 * null when the table is not a destination of that integration or not yet
 * created.
 */
export async function getTableRows(
  pool: pg.Pool,
  integrationId: string,
  tableId: string,
  limit = 100
): Promise<TablePreview | null> {
  const owner = await pool.query(
    `SELECT 1 FROM app.integrations
     WHERE id = $1 AND definition->'destinations' @> $2::jsonb`,
    [integrationId, JSON.stringify([{ kind: "table", tableId }])]
  )
  if (owner.rows.length === 0) return null

  const columns = await pool.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'data' AND table_name = $1 ORDER BY ordinal_position`,
    [tableId]
  )
  if (columns.rows.length === 0) return null
  const names = columns.rows.map(r => r.column_name).filter(n => n !== "_id" && n !== "_run_id")
  const selectList = columns.rows
    .filter(r => names.includes(r.column_name))
    .map(r => {
      if (r.udt_name === "geometry") return `ST_AsGeoJSON("${r.column_name}")::json AS "${r.column_name}"`
      // Bare dates as text, or the driver shifts them through the local timezone
      if (r.udt_name === "date") return `"${r.column_name}"::text AS "${r.column_name}"`
      return `"${r.column_name}"`
    })
    .join(", ")

  const rows = await pool.query(`SELECT ${selectList} FROM data."${tableId}" ORDER BY _id DESC LIMIT $1`, [limit])
  return { columns: names, rows: rows.rows }
}

/** Quotes an identifier (ids are slug-validated at install; quoting is belt-and-braces). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "")}"`
}

/** Normalizes a count value from pg (string/bigint/null) to number|null. */
function toCount(value: unknown): number | null {
  return value == null ? null : Number(value)
}

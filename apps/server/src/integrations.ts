import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"

/** Summary row for the integrations list. */
export interface IntegrationSummary {
  /** Integration id */
  id: string
  /** Display name from the definition */
  name: string
  /** Runtime image id */
  runtime: string
  /** Trigger spec from the definition */
  trigger: unknown
  /** Number of declared destinations */
  destinations: number
  /** Whether the scheduler considers it */
  enabled: boolean
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
  /** Installed definition */
  definition: IntegrationDefinition
  /** Deployment overrides applied at run time */
  overrides: unknown
  /** Whether the scheduler considers it */
  enabled: boolean
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
    `SELECT i.id, i.definition->>'name' AS name, i.definition->>'runtime' AS runtime,
            i.definition->'trigger' AS trigger,
            COALESCE(jsonb_array_length(i.definition->'destinations'), 0) AS destinations,
            i.enabled, r.status AS last_status, COALESCE(r.finished_at, r.started_at) AS last_at
     FROM app.integrations i
     LEFT JOIN LATERAL (
       SELECT status, started_at, finished_at FROM app.runs
       WHERE integration_id = i.id ORDER BY scheduled_at DESC LIMIT 1
     ) r ON true
     ORDER BY i.updated_at DESC`
  )
  return result.rows.map(row => ({
    id: row.id,
    name: row.name ?? row.id,
    runtime: row.runtime ?? "?",
    trigger: row.trigger ?? {},
    destinations: row.destinations,
    enabled: row.enabled,
    lastRunStatus: row.last_status ?? null,
    lastRunAt: row.last_at ? row.last_at.toISOString() : null
  }))
}

/** Loads one integration with run history and destination stats, or null. */
export async function getIntegration(pool: pg.Pool, id: string): Promise<IntegrationDetail | null> {
  const result = await pool.query(
    "SELECT definition, overrides, enabled, updated_at FROM app.integrations WHERE id = $1",
    [id]
  )
  if (result.rows.length === 0) return null
  const { definition, overrides, enabled, updated_at } = result.rows[0]

  const runs = await pool.query(
    `SELECT id, trigger, status, started_at, finished_at, stats, error
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
    definition,
    overrides,
    enabled,
    updatedAt: updated_at.toISOString(),
    runs: runs.rows.map(row => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      stats: row.stats,
      error: row.error
    })),
    destinations
  }
}

/** Quotes an identifier (ids are slug-validated at install; quoting is belt-and-braces). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "")}"`
}

/** Normalizes a count value from pg (string/bigint/null) to number|null. */
function toCount(value: unknown): number | null {
  return value == null ? null : Number(value)
}

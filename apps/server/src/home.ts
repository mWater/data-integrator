/**
 * The home page summary: one round trip for everything the landing page needs,
 * so it does not fan out to the sources, integrations, dashboards and library
 * endpoints and reduce the four results client-side. Panels are capped here
 * rather than in the UI, and each carries the full count so the page can link
 * out honestly.
 */

import pg from "pg"
import { listDashboards } from "./dashboards/service.js"
import { listIntegrations } from "./integrations.js"
import { listLibrary } from "./library.js"
import { DEFAULT_SITE_TITLE, getSiteTitle } from "./settings.js"
import { listSources } from "./sources.js"

/** Rows each home panel shows before deferring to its section page. */
const PANEL_LIMIT = 4

/** One data source row on the home page. */
export interface HomeSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: string
  /** Row count (tables); null for rasters and before the first run */
  rows: number | null
  /** Declared column count (tables); null for rasters */
  columns: number | null
  /** Promoted snapshot count (rasters); null for tables */
  snapshots: number | null
  /** Latest data time (ISO); null before the first run */
  updatedAt: string | null
}

/** One integration row on the home page. */
export interface HomeIntegration {
  /** Integration id */
  id: string
  /** Display name */
  name: string
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Status of the most recent run, if any */
  lastRunStatus: string | null
  /** Time of the most recent run (ISO) */
  lastRunAt: string | null
}

/** An enabled integration whose most recent run failed. */
export interface HomeProblem {
  /** Integration id */
  id: string
  /** Display name */
  name: string
  /** Terminal status of the failing run */
  status: string
  /** Error recorded on the run, when there is one */
  error: string | null
  /** When the run failed (ISO) */
  failedAt: string | null
}

/** Headline counts behind the home page's action cards and panel links. */
export interface HomeCounts {
  /** Installed integrations */
  integrations: number
  /** Destination tables holding data */
  tables: number
  /** Raster layers holding data */
  rasters: number
  /** Saved dashboards */
  dashboards: number
  /** Library entries available to install; null when the count was not needed */
  library: number | null
}

/** Which agent-backed features this deployment has a model configured for. */
export interface HomeAi {
  /** Designing and editing integrations with the agent */
  designer: boolean
  /** Building dashboards with the agent */
  dashboards: boolean
  /** The query assistant */
  assistant: boolean
}

/** Everything the home page renders. */
export interface HomeSummary {
  /** Deployment display name, already resolved against the default */
  title: string
  /** True once any destination holds data: switches the page out of its welcome state */
  hasData: boolean
  /** Headline counts */
  counts: HomeCounts
  /** Freshest data sources, capped */
  sources: HomeSource[]
  /** Integrations, most recently updated first, capped */
  integrations: HomeIntegration[]
  /** Enabled integrations whose most recent run failed */
  problems: HomeProblem[]
  /** Agent-backed features available on this deployment */
  ai: HomeAi
}

/** Enabled integrations whose most recent run ended badly, newest first. */
async function listProblems(pool: pg.Pool): Promise<HomeProblem[]> {
  const result = await pool.query(
    `SELECT i.id, i.definition->>'name' AS name, r.status, r.error,
            COALESCE(r.finished_at, r.started_at) AS failed_at
     FROM app.integrations i
     JOIN LATERAL (
       SELECT status, error, started_at, finished_at FROM app.runs
       WHERE integration_id = i.id ORDER BY scheduled_at DESC LIMIT 1
     ) r ON true
     WHERE i.enabled AND r.status IN ('failed', 'timeout')
     ORDER BY failed_at DESC NULLS LAST`
  )
  return result.rows.map(row => ({
    id: row.id,
    name: row.name ?? row.id,
    status: row.status,
    error: row.error,
    failedAt: row.failed_at ? row.failed_at.toISOString() : null
  }))
}

/**
 * Builds the home page summary. `ai` reflects which agent services the server
 * was started with, so the page can drop the cards it cannot honour.
 */
export async function getHomeSummary(
  pool: pg.Pool,
  libraryPath: string | null,
  ai: HomeAi
): Promise<HomeSummary> {
  const [title, sources, integrations, dashboards, problems] = await Promise.all([
    getSiteTitle(pool),
    listSources(pool),
    listIntegrations(pool),
    listDashboards(pool),
    listProblems(pool)
  ])

  // A source counts as data only once it holds some: a declared table with no
  // rows yet would otherwise take the page out of its welcome state early.
  const filled = sources.filter(s => (s.rows ?? 0) > 0 || (s.snapshots ?? 0) > 0)

  // Only the welcome state names a library figure, and listing costs a read per
  // entry, so skip it entirely once the deployment has integrations.
  const library =
    libraryPath && integrations.length === 0 ? (await listLibrary(pool, libraryPath)).length : null

  return {
    title: title ?? DEFAULT_SITE_TITLE,
    hasData: filled.length > 0,
    counts: {
      integrations: integrations.length,
      tables: filled.filter(s => s.kind === "table").length,
      rasters: filled.filter(s => s.kind === "raster").length,
      dashboards: dashboards.length,
      library
    },
    sources: filled.slice(0, PANEL_LIMIT).map(s => ({
      kind: s.kind,
      id: s.id,
      name: s.name,
      rows: s.rows,
      columns: s.columns,
      snapshots: s.snapshots,
      updatedAt: s.updatedAt
    })),
    integrations: integrations.slice(0, PANEL_LIMIT).map(i => ({
      id: i.id,
      name: i.name,
      enabled: i.enabled,
      status: i.status,
      lastRunStatus: i.lastRunStatus,
      lastRunAt: i.lastRunAt
    })),
    problems,
    ai
  }
}

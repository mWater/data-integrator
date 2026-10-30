/**
 * The home page summary: one round trip for everything the landing page needs,
 * so it does not fan out to the sources, integrations, dashboards and library
 * endpoints and reduce the four results client-side. Panels are capped here
 * rather than in the UI, and each carries the full count so the page can link
 * out honestly.
 */

import pg from "pg"
import { durationMs, RunFlag } from "./validation.js"
import { listDashboards } from "./dashboards/service.js"
import { listIntegrations } from "./integrations.js"
import { listLibrary } from "./library.js"
import { DEFAULT_SITE_TITLE, getSiteTitle } from "./settings.js"
import { listSources } from "./sources.js"
import { LocalizedString } from "@data-integrator/definitions"

/** Rows each home panel shows before deferring to its section page. */
const PANEL_LIMIT = 4

/** One data source row on the home page. */
export interface HomeSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: LocalizedString
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
  name: LocalizedString
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
  name: LocalizedString
  /** Terminal status of the failing run */
  status: string
  /** Error recorded on the run, when there is one */
  error: string | null
  /** When the run failed (ISO) */
  failedAt: string | null
}

/** An integration waiting for credentials before it can run. */
export interface HomeCredentialNeed {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** draft (still in a design session) or ready */
  status: string
  /** Declared secret names with no stored value */
  missing: string[]
  /** Paused design session that requested them, when there is one */
  sessionId: string | null
}

/** An enabled integration whose data needs a look: its latest run raised flags, or it is overdue. */
export interface HomeQualityIssue {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** flagged: the latest successful run raised validation flags; stale: no success within twice validation.expectedCadence */
  kind: "flagged" | "stale"
  /** Flag messages (flagged only) */
  messages: string[]
  /** Latest successful run's finish time (ISO), or null when it never succeeded */
  lastSuccessAt: string | null
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
  /** Integrations whose declared credentials are not all stored */
  credentialsNeeded: HomeCredentialNeed[]
  /** Integrations whose latest data raised validation flags or is overdue */
  quality: HomeQualityIssue[]
  /** Agent-backed features available on this deployment */
  ai: HomeAi
}

/**
 * Enabled integrations (drafts included) declaring secrets that are not all
 * stored, with the paused design session that asked for them when one exists.
 */
async function listCredentialsNeeded(pool: pg.Pool): Promise<HomeCredentialNeed[]> {
  const result = await pool.query(
    `SELECT i.id, i.definition->'name' AS name, i.status,
            array_agg(d.name ORDER BY d.ord) AS missing,
            (SELECT s.id FROM app.agent_sessions s
              WHERE s.kind = 'designer' AND s.status = 'paused'
                AND s.client_state->'definition'->>'id' = i.id
              ORDER BY s.updated_at DESC LIMIT 1) AS session_id
     FROM app.integrations i
     CROSS JOIN LATERAL jsonb_array_elements_text(i.definition->'secrets') WITH ORDINALITY AS d(name, ord)
     LEFT JOIN app.integration_secrets sec ON sec.integration_id = i.id AND sec.name = d.name
     WHERE i.enabled AND sec.name IS NULL
     GROUP BY i.id, i.definition, i.status, i.updated_at
     ORDER BY i.updated_at DESC`
  )
  return result.rows.map(row => ({
    id: row.id,
    name: row.name ?? { _base: "en", en: row.id },
    status: row.status,
    missing: row.missing,
    sessionId: row.session_id ?? null
  }))
}

/**
 * Enabled, ready integrations whose latest successful run raised flags, or
 * that declare an expected cadence and have not succeeded within twice it.
 * One that is failing outright already shows under problems.
 */
async function listQualityIssues(pool: pg.Pool, problemIds: Set<string>): Promise<HomeQualityIssue[]> {
  const result = await pool.query(
    `SELECT i.id, i.definition->'name' AS name, i.definition->'validation'->>'expectedCadence' AS cadence,
            r.flags, r.finished_at
     FROM app.integrations i
     LEFT JOIN LATERAL (
       SELECT flags, finished_at FROM app.runs
       WHERE integration_id = i.id AND status = 'succeeded' AND session_id IS NULL
       ORDER BY finished_at DESC LIMIT 1
     ) r ON true
     WHERE i.enabled AND i.status = 'ready'
       AND (r.flags IS NOT NULL OR i.definition->'validation' ? 'expectedCadence')
     ORDER BY i.updated_at DESC`
  )
  const issues: HomeQualityIssue[] = []
  for (const row of result.rows) {
    if (problemIds.has(row.id)) continue
    const name = row.name ?? { _base: "en", en: row.id }
    const lastSuccessAt = row.finished_at ? (row.finished_at as Date).toISOString() : null
    const cadence = row.cadence ? durationMs(row.cadence) : null
    if (cadence !== null && (!row.finished_at || Date.now() - (row.finished_at as Date).getTime() > 2 * cadence)) {
      issues.push({ id: row.id, name, kind: "stale", messages: [], lastSuccessAt })
    } else if (row.flags) {
      issues.push({ id: row.id, name, kind: "flagged", messages: (row.flags as RunFlag[]).map(f => f.message), lastSuccessAt })
    }
  }
  return issues
}

/** Enabled integrations whose most recent run ended badly, newest first. */
async function listProblems(pool: pg.Pool): Promise<HomeProblem[]> {
  const result = await pool.query(
    `SELECT i.id, i.definition->'name' AS name, r.status, r.error,
            COALESCE(r.finished_at, r.started_at) AS failed_at
     FROM app.integrations i
     JOIN LATERAL (
       SELECT status, error, started_at, finished_at FROM app.runs
       WHERE integration_id = i.id ORDER BY scheduled_at DESC LIMIT 1
     ) r ON true
     WHERE i.enabled AND i.status = 'ready' AND r.status IN ('failed', 'timeout')
     ORDER BY failed_at DESC NULLS LAST`
  )
  return result.rows.map(row => ({
    id: row.id,
    name: row.name ?? { _base: "en", en: row.id },
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
  const [title, sources, integrations, dashboards, problems, credentialsNeeded] = await Promise.all([
    getSiteTitle(pool),
    listSources(pool),
    listIntegrations(pool),
    listDashboards(pool),
    listProblems(pool),
    listCredentialsNeeded(pool)
  ])

  // A source counts as data only once it holds some: a declared table with no
  // rows yet would otherwise take the page out of its welcome state early.
  const filled = sources.filter(s => (s.rows ?? 0) > 0 || (s.snapshots ?? 0) > 0)

  // Only the welcome state names a library figure, and listing costs a read per
  // entry, so skip it entirely once the deployment has integrations.
  const library =
    libraryPath && integrations.length === 0 ? (await listLibrary(pool, libraryPath)).length : null

  const quality = await listQualityIssues(pool, new Set(problems.map(p => p.id)))

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
    credentialsNeeded,
    quality,
    ai
  }
}

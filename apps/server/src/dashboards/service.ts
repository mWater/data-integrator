/**
 * Dashboard persistence and access: versioned save (build included), reads,
 * and the per-dashboard authorization seam.
 */

import pg from "pg"
import { AuthUser } from "../auth.js"
import { buildDashboard, KIT_VERSION } from "./build.js"
import { DashboardQuery, executeStoredQuery, executeTileQuery, validateQueries } from "./queries.js"

/** Dashboard ids are natural keys, library-syncable like integrations. */
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

/** Summary row for the dashboards list. */
export interface DashboardSummary {
  /** Dashboard id. */
  id: string
  /** Display name. */
  name: string
  /** Current version number; null when never saved successfully. */
  currentVersion: number | null
  /** Last update time (ISO 8601). */
  updatedAt: string
}

/** Full dashboard detail at its current version. */
export interface DashboardDetail extends DashboardSummary {
  /** React source of the current version. */
  source: string
  /** Stored queries of the current version. */
  queries: DashboardQuery[]
  /** Kit version the bundle was built against. Provenance only: the loader
   * always uses the current kit, so this never selects an asset. */
  builtWithKit: string
  /** Compiled ESM bundle. */
  bundleJs: string
  /** Compiled stylesheet. */
  bundleCss: string
}

/**
 * Per-dashboard authorization: may this user view this dashboard? Today every
 * authenticated user passes; dashboard-only principals (share links) slot in
 * here without touching callers.
 */
export function canViewDashboard(user: AuthUser, dashboardId: string): boolean {
  void user
  void dashboardId
  return true
}

/** Lists dashboards, newest first. */
export async function listDashboards(pool: pg.Pool): Promise<DashboardSummary[]> {
  const result = await pool.query(
    "SELECT id, name, current_version, updated_at FROM app.dashboards ORDER BY updated_at DESC"
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    currentVersion: row.current_version,
    updatedAt: row.updated_at.toISOString()
  }))
}

/** Loads a dashboard at its current version; null when absent or unsaved. */
export async function getDashboard(pool: pg.Pool, id: string): Promise<DashboardDetail | null> {
  const result = await pool.query(
    `SELECT d.id, d.name, d.current_version, d.updated_at,
            v.source, v.queries, v.kit_version, v.bundle_js, v.bundle_css
     FROM app.dashboards d
     JOIN app.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.current_version
     WHERE d.id = $1`,
    [id]
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    currentVersion: row.current_version,
    updatedAt: row.updated_at.toISOString(),
    source: row.source,
    queries: row.queries,
    builtWithKit: row.kit_version,
    bundleJs: row.bundle_js,
    bundleCss: row.bundle_css
  }
}

/** Input to a dashboard save. */
export interface SaveDashboardInput {
  /** Dashboard id (natural key). */
  id: string
  /** Display name. */
  name: string
  /** React source to build. */
  source: string
  /** Stored queries frozen with this version. */
  queries: DashboardQuery[]
}

/** Result of a save: the new version, or the build/validation errors. */
export interface SaveDashboardResult {
  /** True when built and stored. */
  ok: boolean
  /** New version number when ok. */
  version?: number
  /** Validation or build errors when not ok. */
  errors: string[]
}

/** Validates, builds, and stores a new dashboard version atomically. */
export async function saveDashboard(pool: pg.Pool, input: SaveDashboardInput): Promise<SaveDashboardResult> {
  const errors: string[] = []
  if (!ID_PATTERN.test(input.id)) errors.push(`dashboard id must match ${ID_PATTERN}`)
  if (typeof input.name !== "string" || input.name.trim() === "") errors.push("name is required")
  if (!Array.isArray(input.queries)) errors.push("queries must be an array")
  else errors.push(...validateQueries(input.queries))
  if (typeof input.source !== "string" || input.source.trim() === "") errors.push("source is required")
  if (errors.length > 0) return { ok: false, errors }

  const built = await buildDashboard(input.source)
  if (!built.ok) return { ok: false, errors: built.errors }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      `INSERT INTO app.dashboards (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = now()`,
      [input.id, input.name]
    )
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM app.dashboard_versions WHERE dashboard_id = $1`,
      [input.id]
    )
    const version = versionResult.rows[0].next as number
    await client.query(
      `INSERT INTO app.dashboard_versions
         (dashboard_id, version, source, queries, kit_version, bundle_js, bundle_css)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.id, version, input.source, JSON.stringify(input.queries), KIT_VERSION, built.bundleJs, built.bundleCss]
    )
    await client.query("UPDATE app.dashboards SET current_version = $2, updated_at = now() WHERE id = $1", [
      input.id,
      version
    ])
    await client.query("COMMIT")
    return { ok: true, version, errors: [] }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** What a delete removed. */
export interface DeleteDashboardResult {
  /** False when no such dashboard exists. */
  ok: boolean
  /** Versions deleted with it. */
  versions: number
  /** Design sessions kept, with their dashboard binding cleared. */
  sessions: number
}

/**
 * Permanently deletes a dashboard and every stored version. Design sessions
 * survive with their binding cleared, so the transcript of how a dashboard was
 * built outlives the dashboard itself.
 */
export async function deleteDashboard(pool: pg.Pool, id: string): Promise<DeleteDashboardResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const existing = await client.query("SELECT id FROM app.dashboards WHERE id = $1 FOR UPDATE", [id])
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK")
      return { ok: false, versions: 0, sessions: 0 }
    }
    // current_version points into dashboard_versions; release it before the rows go
    await client.query("UPDATE app.dashboards SET current_version = NULL WHERE id = $1", [id])
    const sessions = await client.query(
      "UPDATE app.agent_sessions SET dashboard_id = NULL WHERE dashboard_id = $1",
      [id]
    )
    const versions = await client.query("DELETE FROM app.dashboard_versions WHERE dashboard_id = $1", [id])
    await client.query("DELETE FROM app.dashboards WHERE id = $1", [id])
    await client.query("COMMIT")
    return { ok: true, versions: versions.rowCount ?? 0, sessions: sessions.rowCount ?? 0 }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Executes a stored query of a dashboard's current version. */
export async function executeDashboardQuery(
  pool: pg.Pool,
  dashboardId: string,
  queryName: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>[] | null> {
  const detail = await getDashboard(pool, dashboardId)
  if (!detail) return null
  const query = detail.queries.find((q) => q.name === queryName)
  if (!query) return null
  return executeStoredQuery(pool, query, values)
}

/**
 * Executes a tile query of a dashboard's current version for one slippy tile;
 * null when the dashboard or query is missing or the query is not a tile query.
 */
export async function executeDashboardTileQuery(
  pool: pg.Pool,
  dashboardId: string,
  queryName: string,
  values: Record<string, unknown>,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  const detail = await getDashboard(pool, dashboardId)
  if (!detail) return null
  const query = detail.queries.find((q) => q.name === queryName && q.tile === true)
  if (!query) return null
  return executeTileQuery(pool, query, values, z, x, y)
}

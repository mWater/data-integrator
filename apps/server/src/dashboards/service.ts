/**
 * Dashboard persistence and access: versioned save (build included), version
 * history and restore, reads, and the per-dashboard authorization seam.
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
  /** True when the dashboard is viewable without signing in. */
  public: boolean
  /** Email of the admin who made it public; null while private. */
  publishedBy: string | null
  /** When it was made public (ISO 8601); null while private. */
  publishedAt: string | null
}

/** Full dashboard detail at its current version. */
export interface DashboardDetail extends DashboardSummary {
  /** React source of the current version. */
  source: string
  /** Stored queries of the current version. */
  queries: DashboardQuery[]
  /** Raster catalog layer ids the version declares (and may draw). */
  layers: string[]
  /** Kit version the bundle was built against. Provenance only: the loader
   * always uses the current kit, so this never selects an asset. */
  builtWithKit: string
  /** Compiled ESM bundle. */
  bundleJs: string
  /** Compiled stylesheet. */
  bundleCss: string
}

/**
 * Per-dashboard authorization: may this principal view this dashboard? Every
 * signed-in user passes; an anonymous viewer passes only when the dashboard
 * is public.
 */
export function canViewDashboard(user: AuthUser | null, dashboard: { public: boolean }): boolean {
  return user !== null || dashboard.public
}

/** Outcome of a rename: ok, or the reason it was refused. */
export interface RenameDashboardResult {
  /** True when the rename applied. */
  ok: boolean
  /** Refusal reason when not ok. */
  error?: string
}

/**
 * Renames a dashboard's slug and/or display name. The id is the natural key;
 * its references are ON UPDATE CASCADE, so one UPDATE moves
 * versions and session bindings with it; the slug inside dashboard sessions'
 * state is rewritten alongside. Existing links (public ones included)
 * point at the old slug and break - the caller warns the user.
 */
export async function renameDashboard(
  pool: pg.Pool,
  id: string,
  newId: string,
  newName: string | null
): Promise<RenameDashboardResult> {
  if (!ID_PATTERN.test(newId)) return { ok: false, error: `dashboard id must match ${ID_PATTERN}` }
  if (newName !== null && newName.trim() === "") return { ok: false, error: "name must not be empty" }
  try {
    const result = await pool.query(
      "UPDATE app.dashboards SET id = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1",
      [id, newId, newName]
    )
    if ((result.rowCount ?? 0) === 0) return { ok: false, error: "unknown dashboard" }
    // Design sessions also carry the slug in their state, which saves target
    if (newId !== id) {
      await pool.query(
        `UPDATE app.agent_sessions SET client_state = jsonb_set(client_state, '{dashboardId}', to_jsonb($2::text))
         WHERE kind = 'dashboard' AND client_state->>'dashboardId' = $1`,
        [id, newId]
      )
    }
    return { ok: true }
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, error: `a dashboard named "${newId}" already exists` }
    throw err
  }
}

/**
 * Sets the public flag, recording who made it public and when (cleared when
 * made private); false when no such dashboard exists.
 */
export async function setDashboardPublic(pool: pg.Pool, id: string, isPublic: boolean, userId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.dashboards
     SET public = $2,
         published_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         published_at = CASE WHEN $2 THEN now() ELSE NULL END
     WHERE id = $1`,
    [id, isPublic, userId]
  )
  return (result.rowCount ?? 0) > 0
}

/** Lists dashboards, newest first. */
export async function listDashboards(pool: pg.Pool): Promise<DashboardSummary[]> {
  const result = await pool.query(
    `SELECT d.id, d.name, d.current_version, d.updated_at, d.public, d.published_at, u.email AS published_by
     FROM app.dashboards d LEFT JOIN app.users u ON u.id = d.published_by
     ORDER BY d.updated_at DESC`
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    currentVersion: row.current_version,
    updatedAt: row.updated_at.toISOString(),
    public: row.public,
    publishedBy: row.published_by ?? null,
    publishedAt: row.published_at ? row.published_at.toISOString() : null
  }))
}

/** Loads a dashboard at its current version; null when absent or unsaved. */
export async function getDashboard(pool: pg.Pool, id: string): Promise<DashboardDetail | null> {
  const result = await pool.query(
    `SELECT d.id, d.name, d.current_version, d.updated_at, d.public, d.published_at, u.email AS published_by,
            v.source, v.queries, v.layers, v.kit_version, v.bundle_js, v.bundle_css
     FROM app.dashboards d
     JOIN app.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.current_version
     LEFT JOIN app.users u ON u.id = d.published_by
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
    public: row.public,
    publishedBy: row.published_by ?? null,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    source: row.source,
    queries: row.queries,
    layers: row.layers,
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
  /** Raster catalog layer ids the version declares. */
  layers: string[]
  /** User saving the version; omitted for saves no account made. */
  createdBy?: string
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
  if (!Array.isArray(input.layers) || input.layers.some((l) => typeof l !== "string")) {
    errors.push("layers must be an array of raster layer ids")
  } else if (input.layers.length > 0) {
    // Declared layers must exist: the scoped tile route serves only these
    const known = await pool.query("SELECT id FROM app.raster_layers WHERE id = ANY($1)", [input.layers])
    const knownIds = new Set(known.rows.map((r: { id: string }) => r.id))
    for (const id of input.layers) {
      if (!knownIds.has(id)) errors.push(`unknown raster layer "${id}"`)
    }
  }
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
         (dashboard_id, version, source, queries, layers, kit_version, bundle_js, bundle_css, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        version,
        input.source,
        JSON.stringify(input.queries),
        JSON.stringify(input.layers),
        KIT_VERSION,
        built.bundleJs,
        built.bundleCss,
        input.createdBy ?? null
      ]
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

/** One stored version in a dashboard's history. */
export interface DashboardVersionSummary {
  /** Version number, counting up from 1. */
  version: number
  /** When it was saved (ISO 8601). */
  createdAt: string
  /** Email of the user who saved it; null when not recorded. */
  createdBy: string | null
  /** The version this one copied, when it was made by a restore. */
  restoredFrom: number | null
}

/** A dashboard's versions, newest first; null when no such dashboard exists. */
export async function listDashboardVersions(pool: pg.Pool, id: string): Promise<DashboardVersionSummary[] | null> {
  const exists = await pool.query("SELECT 1 FROM app.dashboards WHERE id = $1", [id])
  if (exists.rows.length === 0) return null
  const result = await pool.query(
    `SELECT v.version, v.created_at, u.email AS created_by, v.restored_from
     FROM app.dashboard_versions v LEFT JOIN app.users u ON u.id = v.created_by
     WHERE v.dashboard_id = $1
     ORDER BY v.version DESC`,
    [id]
  )
  return result.rows.map((row) => ({
    version: row.version,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by ?? null,
    restoredFrom: row.restored_from ?? null
  }))
}

/** Outcome of a restore: the new version, or why it was refused. */
export interface RestoreDashboardResult {
  /** True when the restored copy is the current version. */
  ok: boolean
  /** The new version number when ok. */
  version?: number
  /** Refusal reason when not ok. */
  error?: string
  /** True when the refusal is a missing dashboard or version. */
  notFound?: boolean
}

/**
 * Restores an earlier version by copying it as a new current version, so
 * history stays linear and the restore can itself be undone. The stored
 * bundle is reused: kit exports are append-only, so a bundle built against an
 * earlier kit runs on the current one. Design sessions on the dashboard keep
 * their drafts but become unsaved against the new version, so saving one
 * again is a deliberate step.
 */
export async function restoreDashboardVersion(
  pool: pg.Pool,
  id: string,
  version: number,
  userId: string
): Promise<RestoreDashboardResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const dashboard = await client.query("SELECT current_version FROM app.dashboards WHERE id = $1 FOR UPDATE", [id])
    if (dashboard.rows.length === 0) {
      await client.query("ROLLBACK")
      return { ok: false, error: "unknown dashboard", notFound: true }
    }
    if (dashboard.rows[0].current_version === version) {
      await client.query("ROLLBACK")
      return { ok: false, error: `version ${version} is already the current version` }
    }
    const next = (
      await client.query(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM app.dashboard_versions WHERE dashboard_id = $1",
        [id]
      )
    ).rows[0].next as number
    const copied = await client.query(
      `INSERT INTO app.dashboard_versions
         (dashboard_id, version, source, queries, layers, kit_version, bundle_js, bundle_css, created_by, restored_from)
       SELECT dashboard_id, $3, source, queries, layers, kit_version, bundle_js, bundle_css, $4, version
       FROM app.dashboard_versions WHERE dashboard_id = $1 AND version = $2`,
      [id, version, next, userId]
    )
    if ((copied.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK")
      return { ok: false, error: `dashboard has no version ${version}`, notFound: true }
    }
    await client.query("UPDATE app.dashboards SET current_version = $2, updated_at = now() WHERE id = $1", [id, next])
    await client.query(
      `UPDATE app.agent_sessions
       SET client_state = client_state || jsonb_build_object('saved', jsonb_build_object('version', $2::int), 'dirty', true)
       WHERE kind = 'dashboard' AND client_state->>'dashboardId' = $1`,
      [id, next]
    )
    await client.query("COMMIT")
    return { ok: true, version: next }
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
  /** Design sessions kept, each now an unsaved draft. */
  sessions: number
}

/**
 * Permanently deletes a dashboard and every stored version. Design sessions
 * survive as unsaved drafts, so the transcript of how a dashboard was built
 * outlives the dashboard itself, and saving one again recreates it.
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
      `UPDATE app.agent_sessions SET client_state = client_state || '{"saved": null, "dirty": true}'::jsonb
       WHERE kind = 'dashboard' AND client_state->>'dashboardId' = $1`,
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

/**
 * Daily housekeeping for tables and directories that otherwise only grow, plus
 * the account policy's inactivity rule:
 *
 * - accounts inactive past the account policy's limit, disabled
 *   (accountPolicy.ts; off by default);
 * - expired sign-in sessions;
 * - webhook events a run has consumed, after WEBHOOK_EVENT_DAYS;
 * - run logs after RUN_LOG_DAYS (the run rows stay: they carry lineage,
 *   stats and errors);
 * - scratch areas (draft tables, preview layers, /work) of design sessions
 *   idle for SCRATCH_IDLE_DAYS; the transcript stays and a resumed session
 *   simply re-runs;
 * - raster store snapshot directories no snapshot row refers to, left by
 *   runs that failed after storing files, once a day old.
 *
 * Snapshot retention proper lives in retention.ts.
 */

import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { RasterStore } from "./rasterStore.js"
import { cleanupScratch, draftSchema } from "./scratch.js"
import { sweepJobTmp } from "./jobTmp.js"
import { disableInactiveAccounts } from "./accountPolicy.js"

/** Consumed webhook events are kept this long for debugging deliveries. */
export const WEBHOOK_EVENT_DAYS = 30
/** Run logs are kept this long; run rows are kept indefinitely. */
export const RUN_LOG_DAYS = 90
/** Design sessions idle this long lose their scratch area. */
export const SCRATCH_IDLE_DAYS = 30
/** Unreferenced store directories younger than this may belong to a run still committing. */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000

/** Snapshot directory names: snapshot ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What one sweep removed or disabled. */
export interface HousekeepingResult {
  /** Accounts disabled for inactivity */
  inactiveAccounts: number
  /** Expired sign-in sessions deleted */
  authSessions: number
  /** Consumed webhook events deleted */
  webhookEvents: number
  /** Run logs cleared */
  runLogs: number
  /** Design sessions whose scratch area was removed */
  scratchSessions: number
  /** Orphaned store snapshot directories removed */
  orphanSnapshots: number
  /** Job /tmp directories left by a crashed process removed */
  leftoverJobTmp: number
}

/** Runs every housekeeping step; each is independent and idempotent. */
export async function sweepHousekeeping(pool: pg.Pool, store: RasterStore, workRoot: string): Promise<HousekeepingResult> {
  const inactiveAccounts = await disableInactiveAccounts(pool)
  const authSessions = (await pool.query("DELETE FROM app.auth_sessions WHERE expires_at < now()")).rowCount ?? 0
  const webhookEvents =
    (await pool.query(
      `DELETE FROM app.webhook_events WHERE run_id IS NOT NULL AND received_at < now() - make_interval(days => $1)`,
      [WEBHOOK_EVENT_DAYS]
    )).rowCount ?? 0
  const runLogs =
    (await pool.query(
      `UPDATE app.runs SET log = NULL WHERE log IS NOT NULL AND finished_at < now() - make_interval(days => $1)`,
      [RUN_LOG_DAYS]
    )).rowCount ?? 0
  return {
    inactiveAccounts,
    authSessions,
    webhookEvents,
    runLogs,
    scratchSessions: await sweepIdleScratch(pool, store, workRoot),
    orphanSnapshots: await sweepOrphanSnapshots(pool, store),
    leftoverJobTmp: await sweepJobTmp(workRoot)
  }
}

/** Removes the scratch areas of design sessions idle past SCRATCH_IDLE_DAYS that still have one. */
async function sweepIdleScratch(pool: pg.Pool, store: RasterStore, workRoot: string): Promise<number> {
  const idle = await pool.query(
    `SELECT s.id FROM app.agent_sessions s
     WHERE s.kind = 'designer' AND s.status <> 'active' AND s.updated_at < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM app.runs r WHERE r.session_id = s.id AND r.status IN ('queued', 'running'))`,
    [SCRATCH_IDLE_DAYS]
  )
  let cleaned = 0
  for (const { id } of idle.rows as { id: string }[]) {
    const has = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2)
           OR EXISTS (SELECT 1 FROM app.raster_layers WHERE session_id = $1) AS has`,
      [id, draftSchema(id)]
    )
    if (!has.rows[0].has) continue
    await cleanupScratch(pool, store, workRoot, id)
    cleaned++
  }
  return cleaned
}

/** Removes `<layer>/<snapshotId>/` directories with no raster_snapshots row, once old enough. */
async function sweepOrphanSnapshots(pool: pg.Pool, store: RasterStore): Promise<number> {
  const layers = await readdir(store.root, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const layer of layers) {
    if (!layer.isDirectory()) continue
    const layerDir = path.join(store.root, layer.name)
    const entries = await readdir(layerDir, { withFileTypes: true }).catch(() => [])
    const ids = entries.filter(e => e.isDirectory() && UUID.test(e.name)).map(e => e.name)
    if (ids.length === 0) continue
    const known = await pool.query("SELECT id::text FROM app.raster_snapshots WHERE id = ANY($1::uuid[])", [ids])
    const live = new Set(known.rows.map(r => r.id as string))
    for (const id of ids) {
      if (live.has(id)) continue
      const dir = path.join(layerDir, id)
      const info = await stat(dir).catch(() => null)
      if (!info || Date.now() - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue
      await rm(dir, { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

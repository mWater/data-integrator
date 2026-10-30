/**
 * Snapshot retention: deletes raster snapshots nothing should read any more,
 * with their store files and cached tiles. Two kinds qualify:
 *
 * - superseded snapshots of any layer (a current-only layer's previous
 *   snapshot, a time-series date that was re-ingested);
 * - promoted snapshots of a time-series layer with retention_days whose
 *   observation ended before the window (observed_end, else observed_at).
 *
 * A snapshot some layer points at as current is never deleted, so a layer
 * whose source stopped publishing keeps its latest picture. Future-dated
 * snapshots (projections) are always inside the window. Scratch layers of
 * design sessions are left to their session cleanup.
 */

import { rm } from "node:fs/promises"
import pg from "pg"
import { RasterStore } from "./rasterStore.js"
import { TileRenderer } from "./tiles.js"

/** Snapshots deleted per transaction, so a first sweep over years of history stays short-locked. */
const BATCH = 200

/** What one sweep removed. */
export interface PruneResult {
  /** Snapshot rows deleted (sources and data.rasters registrations cascade) */
  snapshots: number
  /** Superseded snapshots among them */
  superseded: number
}

/**
 * Deletes expired and superseded snapshots in batches. Rows go first, in a
 * transaction that re-checks the current pointers; files and cached tiles
 * are removed after commit, best-effort (an orphaned file is disk-only).
 */
export async function pruneSnapshots(
  pool: pg.Pool,
  store: RasterStore,
  tiles?: Pick<TileRenderer, "dropSnapshot"> | null
): Promise<PruneResult> {
  const result: PruneResult = { snapshots: 0, superseded: 0 }
  for (;;) {
    const deleted = await pool.query(
      `WITH doomed AS (
         SELECT s.id
         FROM app.raster_snapshots s
         JOIN app.raster_layers l ON l.id = s.layer_id
         WHERE l.integration_id IS NOT NULL AND l.session_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.raster_layers c WHERE c.current_snapshot_id = s.id)
           AND (s.status = 'superseded'
                OR (s.status = 'promoted' AND l.temporality = 'time-series' AND l.retention_days IS NOT NULL
                    AND coalesce(s.observed_end, s.observed_at) < now() - make_interval(days => l.retention_days)))
         ORDER BY s.observed_at
         LIMIT $1
         FOR UPDATE OF s SKIP LOCKED
       ),
       paths AS (
         SELECT snapshot_id, array_agg(path) AS paths FROM app.raster_sources
         WHERE snapshot_id IN (SELECT id FROM doomed) GROUP BY snapshot_id
       )
       DELETE FROM app.raster_snapshots s
       USING doomed d LEFT JOIN paths p ON p.snapshot_id = d.id
       WHERE s.id = d.id
       RETURNING s.id, s.layer_id, s.status, p.paths`,
      [BATCH]
    )
    for (const row of deleted.rows) {
      for (const relPath of (row.paths as string[] | null) ?? []) await store.delete(relPath).catch(() => {})
      // Current layout keeps a snapshot's files in their own directory
      await rm(store.absolute(`${row.layer_id}/${row.id}`), { recursive: true, force: true }).catch(() => {})
      await tiles?.dropSnapshot(row.layer_id, row.id).catch(() => {})
      if (row.status === "superseded") result.superseded++
    }
    result.snapshots += deleted.rows.length
    if (deleted.rows.length < BATCH) return result
  }
}

/**
 * Out-db raster registration: mirrors promoted snapshots into data.rasters as
 * tiled PostGIS out-db rasters referencing the COG files. Pixels stay in the
 * store; the database holds tile-grid metadata, so SQL composes raster values
 * with vector rows (ST_Value at points, ST_SummaryStats over clipped
 * buffers) under the read-only sql_engine role.
 *
 * Registration is required and happens inside the run's commit transaction:
 * SQL is a first-class consumer of raster data, so a snapshot the database
 * cannot register fails the run instead of silently missing from the query
 * surface. The Postgres server process must be able to read the raster store
 * path (same host or shared mount, world-readable files) with the out-db
 * settings enabled. `cli.js register-rasters` backfills registrations for
 * snapshots that predate this requirement or after a store move.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import pg from "pg"

const execFileP = promisify(execFile)

/**
 * Tile size of registered rasters. Every tile of a snapshot's full grid gets a
 * row whether or not it holds data, so row count scales with grid area: a
 * daily 20 m country-wide layer is ~2,400 rows per snapshot at 1024 versus
 * ~39,000 at 256. A clip loads whole tiles, 1 MB per byte band at this size.
 */
const TILE_SIZE = 1024

/** What registration needs to know about a snapshot. */
export interface SnapshotRef {
  snapshotId: string
  layerId: string
  /** ISO timestamps */
  observedAt: string
  observedEnd: string | null
  /** "AUTH:code" (e.g. "EPSG:4326", "ESRI:54009"); must resolve in spatial_ref_sys */
  crs: string
  /** Absolute paths of the stored COGs, as the database server must see them; empty for an empty snapshot */
  absolutePaths: string[]
}

/**
 * Enables out-db raster access for the session when permitted; otherwise the
 * database-level settings from the migration/deploy step carry it. Call
 * outside a transaction so a permissions failure cannot poison it.
 */
export async function enableOutDbSession(client: pg.ClientBase): Promise<void> {
  await client.query("SET postgis.enable_outdb_rasters = on").catch(() => {})
  await client.query("SET postgis.gdal_enabled_drivers = 'ENABLE_ALL'").catch(() => {})
}

/**
 * Resolves an "AUTH:code" CRS to the database's SRID via spatial_ref_sys
 * (EPSG codes are their own SRID; ESRI and other authorities ship with
 * PostGIS under their own numbers). Throws when the database does not know
 * the CRS.
 */
export async function resolveSrid(client: pg.ClientBase, snapshotId: string, crs: string): Promise<number> {
  const match = crs.match(/^([A-Za-z][A-Za-z0-9_]*):(\d+)$/)
  if (!match) throw new Error(`Snapshot ${snapshotId} has unparseable CRS "${crs}"; not registering`)
  const found = await client.query("SELECT srid FROM spatial_ref_sys WHERE auth_name = $1 AND auth_srid = $2", [
    match[1].toUpperCase(),
    Number(match[2])
  ])
  if (found.rows.length === 0) {
    throw new Error(`Snapshot ${snapshotId} has CRS "${crs}" unknown to spatial_ref_sys; not registering`)
  }
  return found.rows[0].srid
}

/** gdalinfo facts registration needs; throws when the file cannot be described. */
async function describeRaster(snapshotId: string, absolutePath: string) {
  const { stdout } = await execFileP("gdalinfo", ["-json", absolutePath], { maxBuffer: 16 * 1024 * 1024 })
  const info = JSON.parse(stdout) as {
    size: [number, number]
    geoTransform?: number[]
    bands?: unknown[]
  }
  if (!info.geoTransform) throw new Error(`Snapshot ${snapshotId} has no geotransform; not registering`)
  return { width: info.size[0], height: info.size[1], gt: info.geoTransform, bandCount: info.bands?.length ?? 1 }
}

/**
 * Proves a snapshot would register (CRS resolvable, files describable)
 * without inserting anything. Scratch runs call this so certification
 * catches registration failures during design, not on the first
 * production run.
 */
export async function validateRasterSqlRef(
  client: pg.ClientBase,
  ref: Pick<SnapshotRef, "snapshotId" | "crs" | "absolutePaths">
): Promise<void> {
  if (ref.absolutePaths.length === 0) return
  await resolveSrid(client, ref.snapshotId, ref.crs)
  for (const file of ref.absolutePaths) await describeRaster(ref.snapshotId, file)
}

/**
 * Registers one snapshot inside the caller's transaction, replacing any
 * previous registration: one tiled out-db raster per source file, all under
 * the snapshot id. An empty snapshot registers nothing, so SQL over that
 * time sees no pixels, which is the truth. Throws with a clear message when
 * the CRS is not in spatial_ref_sys, gdalinfo fails, or the database rejects
 * out-db access. Call enableOutDbSession on the client before opening the
 * transaction.
 */
export async function registerRasterSqlInTx(client: pg.ClientBase, ref: SnapshotRef): Promise<void> {
  await client.query("DELETE FROM data.rasters WHERE snapshot_id = $1", [ref.snapshotId])
  if (ref.absolutePaths.length === 0) return
  const srid = await resolveSrid(client, ref.snapshotId, ref.crs)
  for (const file of ref.absolutePaths) {
    const { width, height, gt, bandCount } = await describeRaster(ref.snapshotId, file)
    await client.query(
      `INSERT INTO data.rasters (layer_id, snapshot_id, observed_at, observed_end, rast)
       SELECT $1, $2, $3, $4,
              ST_Tile(
                ST_AddBand(
                  ST_MakeEmptyRaster($5::int, $6::int, $7, $8, $9, $10, $11, $12, $13::int),
                  1, $14::text, (SELECT array_agg(i) FROM generate_series(1, $15::int) i)
                ),
                $16::int, $16::int
              )`,
      [
        ref.layerId,
        ref.snapshotId,
        ref.observedAt,
        ref.observedEnd,
        width,
        height,
        gt[0], // upper-left x
        gt[3], // upper-left y
        gt[1], // x scale
        gt[5], // y scale
        gt[2], // x skew
        gt[4], // y skew
        srid,
        file,
        bandCount,
        TILE_SIZE
      ]
    )
  }
}

/**
 * Registers one snapshot in its own transaction (the backfill path; runs
 * register via registerRasterSqlInTx inside their commit transaction).
 */
export async function registerRasterSql(pool: pg.Pool, ref: SnapshotRef): Promise<void> {
  const client = await pool.connect()
  try {
    await enableOutDbSession(client)
    await client.query("BEGIN")
    await registerRasterSqlInTx(client, ref)
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Drops registrations whose snapshot is no longer promoted (superseded
 * current-only snapshots); hard snapshot deletes cascade via FK.
 */
export async function pruneRasterSql(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM data.rasters r
     WHERE NOT EXISTS (
       SELECT 1 FROM app.raster_snapshots s WHERE s.id = r.snapshot_id AND s.status = 'promoted'
     )`
  )
  return result.rowCount ?? 0
}

/**
 * Registers every promoted snapshot missing from data.rasters and prunes
 * stale rows. With `all`, re-registers every promoted snapshot instead, one
 * transaction each, so existing rows pick up a changed tile size. Returns
 * counts; failures are collected, not thrown, so one unreadable file cannot
 * block the rest.
 */
export async function registerMissingRasters(
  pool: pg.Pool,
  storeAbsolute: (relPath: string) => string,
  options: { all?: boolean } = {}
): Promise<{ registered: number; pruned: number; failures: string[] }> {
  // Empty snapshots have nothing to register and never count as missing
  const missing = await pool.query(
    `SELECT s.id, s.layer_id, s.observed_at, s.observed_end, s.crs,
            (SELECT array_agg(path ORDER BY ordinal) FROM app.raster_sources WHERE snapshot_id = s.id) AS paths
     FROM app.raster_snapshots s
     WHERE s.status = 'promoted'
       AND ($1 OR NOT EXISTS (SELECT 1 FROM data.rasters r WHERE r.snapshot_id = s.id))
       AND EXISTS (SELECT 1 FROM app.raster_sources WHERE snapshot_id = s.id)
       AND s.layer_id IN (SELECT id FROM app.raster_layers WHERE integration_id IS NOT NULL)`,
    [options.all === true]
  )
  let registered = 0
  const failures: string[] = []
  for (const row of missing.rows) {
    try {
      await registerRasterSql(pool, {
        snapshotId: row.id,
        layerId: row.layer_id,
        observedAt: row.observed_at.toISOString(),
        observedEnd: row.observed_end ? row.observed_end.toISOString() : null,
        crs: row.crs,
        absolutePaths: (row.paths as string[]).map(p => path.resolve(storeAbsolute(p)))
      })
      registered++
    } catch (err) {
      failures.push(`${row.layer_id}/${row.id}: ${err instanceof Error ? err.message : err}`)
    }
  }
  const pruned = await pruneRasterSql(pool)
  return { registered, pruned, failures }
}

/**
 * Out-db raster registration: mirrors promoted snapshots into data.rasters as
 * tiled PostGIS out-db rasters referencing the COG files. Pixels stay in the
 * store; the database holds tile-grid metadata, so SQL composes raster values
 * with vector rows (ST_Value at points, ST_SummaryStats over clipped
 * buffers) under the read-only sql_engine role.
 *
 * Registration is best-effort by design: it requires the Postgres server to
 * read the store files and the out-db settings to be enabled, which holds in
 * the reference single-host deployment but not everywhere (e.g. the CI
 * database runs in a container without the host filesystem). A snapshot that
 * fails to register is still served by the catalog API, tiles, and
 * downloads; `cli.js register-rasters` retries stragglers.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import pg from "pg"

const execFileP = promisify(execFile)

/** Tile size of registered rasters; matches typical COG internal tiling. */
const TILE_SIZE = 256

/** What registration needs to know about a snapshot. */
export interface SnapshotRef {
  snapshotId: string
  layerId: string
  /** ISO timestamps */
  observedAt: string
  observedEnd: string | null
  /** "EPSG:nnnn"; anything else cannot be registered */
  crs: string
  /** Absolute path of the stored COG, as the database server must see it */
  absolutePath: string
}

/**
 * Registers one snapshot, replacing any previous registration. Throws with a
 * clear message when the file has no EPSG CRS, gdalinfo fails, or the
 * database rejects out-db access.
 */
export async function registerRasterSql(pool: pg.Pool, ref: SnapshotRef): Promise<void> {
  const epsg = ref.crs.match(/^EPSG:(\d+)$/)
  if (!epsg) throw new Error(`Snapshot ${ref.snapshotId} has non-EPSG CRS "${ref.crs}"; not registering`)
  const srid = Number(epsg[1])

  const { stdout } = await execFileP("gdalinfo", ["-json", ref.absolutePath], { maxBuffer: 16 * 1024 * 1024 })
  const info = JSON.parse(stdout) as {
    size: [number, number]
    geoTransform?: number[]
    bands?: unknown[]
  }
  const [width, height] = info.size
  const gt = info.geoTransform
  if (!gt) throw new Error(`Snapshot ${ref.snapshotId} has no geotransform; not registering`)
  const bandCount = info.bands?.length ?? 1

  const client = await pool.connect()
  try {
    // Session-level enable when permitted (outside the transaction, so a
    // permissions failure cannot poison it); otherwise the database-level
    // setting from the migration/deploy step carries it
    await client.query("SET postgis.enable_outdb_rasters = on").catch(() => {})
    await client.query("SET postgis.gdal_enabled_drivers = 'ENABLE_ALL'").catch(() => {})
    await client.query("BEGIN")
    await client.query("DELETE FROM data.rasters WHERE snapshot_id = $1", [ref.snapshotId])
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
        ref.absolutePath,
        bandCount,
        TILE_SIZE
      ]
    )
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
 * stale rows. Returns counts; failures are collected, not thrown, so one
 * unreadable file cannot block the rest.
 */
export async function registerMissingRasters(
  pool: pg.Pool,
  storeAbsolute: (relPath: string) => string
): Promise<{ registered: number; pruned: number; failures: string[] }> {
  const missing = await pool.query(
    `SELECT s.id, s.layer_id, s.observed_at, s.observed_end, s.crs, s.path
     FROM app.raster_snapshots s
     LEFT JOIN data.rasters r ON r.snapshot_id = s.id
     WHERE s.status = 'promoted' AND r.snapshot_id IS NULL
       AND s.layer_id IN (SELECT id FROM app.raster_layers WHERE integration_id IS NOT NULL)`
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
        absolutePath: path.resolve(storeAbsolute(row.path))
      })
      registered++
    } catch (err) {
      failures.push(`${row.layer_id}/${row.id}: ${err instanceof Error ? err.message : err}`)
    }
  }
  const pruned = await pruneRasterSql(pool)
  return { registered, pruned, failures }
}

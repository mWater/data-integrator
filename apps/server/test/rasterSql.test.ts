import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { pruneRasterSql, registerMissingRasters, registerRasterSql } from "../src/rasterSql.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/**
 * Out-db reads need the Postgres server to open the test file, which holds
 * only for an external same-host database (TEST_DATABASE_URL), not the
 * containerized podman one.
 */
const AVAILABLE = !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool
let storeDir: string
let tifPath: string

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)

  // A 20x20 constant-value GeoTIFF covering [10,0,30,10], world-readable so
  // the postgres server process can open it
  storeDir = await mkdtemp("/tmp/raster-sql-test-")
  await chmod(storeDir, 0o755)
  tifPath = path.join(storeDir, "snap.tif")
  await execFileP("gdal_create", [
    "-of", "GTiff", "-outsize", "20", "20", "-bands", "1", "-burn", "7",
    "-a_srs", "EPSG:4326", "-a_ullr", "10", "10", "30", "0", tifPath
  ])
  await chmod(tifPath, 0o644)

  // Catalog rows the registration mirrors
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO app.integrations (id, definition, version) VALUES ('rsql_int', '{}', 1)`)
    await client.query(
      `INSERT INTO app.integration_versions (integration_id, version, definition) VALUES ('rsql_int', 1, '{}')`
    )
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  await pool.query(
    `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
     VALUES ('rsql_layer', 'rsql_int', 'Test', 'time-series', '[]')`
  )
  const run = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status) VALUES ('rsql_int', 'manual', 'succeeded') RETURNING id`
  )
  await pool.query(
    `INSERT INTO app.raster_snapshots (id, layer_id, observed_at, footprint, crs, path, bands, run_id, status)
     VALUES ('11111111-1111-1111-1111-111111111111', 'rsql_layer', '2026-08-01T00:00:00Z',
             ST_GeomFromText('POLYGON((10 0, 30 0, 30 10, 10 10, 10 0))', 4326),
             'EPSG:4326', 'rsql_layer/snap.tif', '["v"]', $1, 'promoted')`,
    [run.rows[0].id]
  )
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool?.end()
  await db?.stop()
  await rm(storeDir, { recursive: true, force: true })
})

const SNAPSHOT = "11111111-1111-1111-1111-111111111111"

test("out-db registration makes raster values queryable in SQL", { skip: !AVAILABLE }, async () => {
  await registerRasterSql(pool, {
    snapshotId: SNAPSHOT,
    layerId: "rsql_layer",
    observedAt: "2026-08-01T00:00:00Z",
    observedEnd: null,
    crs: "EPSG:4326",
    absolutePath: tifPath
  })

  const tiles = await pool.query("SELECT count(*)::int AS n FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  assert.equal(tiles.rows[0].n, 1, "20x20 raster fits one 256px tile")

  // Point sampling straight from the COG through the database
  const value = await pool.query(
    `SELECT ST_Value(rast, 1, ST_SetSRID(ST_MakePoint(15, 5), 4326)) AS v
     FROM data.rasters WHERE snapshot_id = $1
       AND ST_Intersects(ST_ConvexHull(rast), ST_SetSRID(ST_MakePoint(15, 5), 4326))`,
    [SNAPSHOT]
  )
  assert.equal(Number(value.rows[0].v), 7)

  // Zonal statistics over a clip, the shape of per-feature buffer queries
  const stats = await pool.query(
    `SELECT (ST_SummaryStats(ST_Clip(rast, ST_MakeEnvelope(12, 2, 18, 8, 4326)))).mean AS mean
     FROM data.rasters WHERE snapshot_id = $1`,
    [SNAPSHOT]
  )
  assert.equal(Number(stats.rows[0].mean), 7)

  // The read-only sql_engine role (dashboards, future assistant) can query it
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE sql_engine")
    const asEngine = await client.query(
      `SELECT ST_Value(rast, 1, ST_SetSRID(ST_MakePoint(15, 5), 4326)) AS v FROM data.rasters WHERE snapshot_id = $1`,
      [SNAPSHOT]
    )
    assert.equal(Number(asEngine.rows[0].v), 7)
    await client.query("ROLLBACK")
  } finally {
    client.release()
  }

  // Re-registration replaces rather than duplicates
  await registerRasterSql(pool, {
    snapshotId: SNAPSHOT,
    layerId: "rsql_layer",
    observedAt: "2026-08-01T00:00:00Z",
    observedEnd: null,
    crs: "EPSG:4326",
    absolutePath: tifPath
  })
  const again = await pool.query("SELECT count(*)::int AS n FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  assert.equal(again.rows[0].n, 1)
})

test("registerMissingRasters backfills and prune drops non-promoted", { skip: !AVAILABLE }, async () => {
  await pool.query("DELETE FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  const result = await registerMissingRasters(pool, () => tifPath)
  assert.equal(result.registered, 1)
  assert.deepEqual(result.failures, [])

  await pool.query("UPDATE app.raster_snapshots SET status = 'superseded' WHERE id = $1", [SNAPSHOT])
  assert.equal(await pruneRasterSql(pool), 1)
  const remaining = await pool.query("SELECT count(*)::int AS n FROM data.rasters")
  assert.equal(remaining.rows[0].n, 0)
  await pool.query("UPDATE app.raster_snapshots SET status = 'promoted' WHERE id = $1", [SNAPSHOT])
})

test("non-EPSG CRS is refused with a clear message", { skip: !AVAILABLE }, async () => {
  await assert.rejects(
    registerRasterSql(pool, {
      snapshotId: SNAPSHOT,
      layerId: "rsql_layer",
      observedAt: "2026-08-01T00:00:00Z",
      observedEnd: null,
      crs: "unknown",
      absolutePath: tifPath
    }),
    /non-EPSG/
  )
})

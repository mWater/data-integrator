import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { pruneRasterSql, registerMissingRasters, registerRasterSql } from "../src/rasterSql.js"
import { registerSnapshot } from "../src/catalog.js"
import { checkSnapshotMetadata, SNAPSHOT_METADATA_MAX_BYTES } from "../src/executor.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool
let storeDir: string
let tifPath: string

before(async () => {
  db = await startTestDb()
  // Session out-db GUCs: the migration's ALTER DATABASE misses connections
  // the pool opened before it ran, and assertions read out-db pixels
  pool = new pg.Pool({
    connectionString: db.url,
    options: "-c postgis.enable_outdb_rasters=on -c postgis.gdal_enabled_drivers=ENABLE_ALL"
  })
  await migrate(pool, MIGRATIONS_DIR)

  // A 20x20 constant-value GeoTIFF covering [10,0,30,10], world-readable so
  // the postgres server process can open it (under tmpdir, which the test
  // database container mounts)
  storeDir = await mkdtemp(path.join(tmpdir(), "raster-sql-test-"))
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
     VALUES ('rsql_layer', 'rsql_int', '{"_base": "en", "en": "Test"}', 'time-series', '[]')`
  )
  const run = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status) VALUES ('rsql_int', 'manual', 'succeeded') RETURNING id`
  )
  await pool.query(
    `INSERT INTO app.raster_snapshots (id, layer_id, observed_at, footprint, crs, bands, run_id, status)
     VALUES ('11111111-1111-1111-1111-111111111111', 'rsql_layer', '2026-08-01T00:00:00Z',
             ST_GeomFromText('POLYGON((10 0, 30 0, 30 10, 10 10, 10 0))', 4326),
             'EPSG:4326', '["v"]', $1, 'promoted')`,
    [run.rows[0].id]
  )
  await pool.query(
    `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint)
     VALUES ('11111111-1111-1111-1111-111111111111', 0, 'rsql_layer/snap.tif',
             ST_GeomFromText('POLYGON((10 0, 30 0, 30 10, 10 10, 10 0))', 4326))`
  )
}, { timeout: 120_000 })

after(async () => {
  await pool?.end()
  await db?.stop()
  await rm(storeDir, { recursive: true, force: true })
})

const SNAPSHOT = "11111111-1111-1111-1111-111111111111"

test("out-db registration makes raster values queryable in SQL", async () => {
  await registerRasterSql(pool, {
    snapshotId: SNAPSHOT,
    layerId: "rsql_layer",
    observedAt: "2026-08-01T00:00:00Z",
    observedEnd: null,
    crs: "EPSG:4326",
    absolutePaths: [tifPath]
  })

  const tiles = await pool.query("SELECT count(*)::int AS n FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  assert.equal(tiles.rows[0].n, 1, "20x20 raster fits one tile")

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
    absolutePaths: [tifPath]
  })
  const again = await pool.query("SELECT count(*)::int AS n FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  assert.equal(again.rows[0].n, 1)
})

test("registerMissingRasters backfills and prune drops non-promoted", async () => {
  await pool.query("DELETE FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  const result = await registerMissingRasters(pool, () => tifPath)
  assert.equal(result.registered, 1)
  assert.deepEqual(result.failures, [])
  assert.equal((await registerMissingRasters(pool, () => tifPath)).registered, 0, "nothing missing")
  const all = await registerMissingRasters(pool, () => tifPath, { all: true })
  assert.equal(all.registered, 1, "--all re-registers present snapshots")
  const tiles = await pool.query("SELECT count(*)::int AS n FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  assert.equal(tiles.rows[0].n, 1, "re-registration replaces rows")

  await pool.query("UPDATE app.raster_snapshots SET status = 'superseded' WHERE id = $1", [SNAPSHOT])
  assert.equal(await pruneRasterSql(pool), 1)
  const remaining = await pool.query("SELECT count(*)::int AS n FROM data.rasters")
  assert.equal(remaining.rows[0].n, 0)
  await pool.query("UPDATE app.raster_snapshots SET status = 'promoted' WHERE id = $1", [SNAPSHOT])
})

test("unknown CRS is refused; ESRI authority codes resolve via spatial_ref_sys", async () => {
  const ref = {
    snapshotId: SNAPSHOT,
    layerId: "rsql_layer",
    observedAt: "2026-08-01T00:00:00Z",
    observedEnd: null,
    absolutePaths: [tifPath]
  }
  await assert.rejects(registerRasterSql(pool, { ...ref, crs: "unknown" }), /unparseable CRS/)
  await assert.rejects(registerRasterSql(pool, { ...ref, crs: "EPSG:999999" }), /unknown to spatial_ref_sys/)

  // Mollweide (equal-area grids like GHSL) registers under the ESRI SRID
  await pool.query("DELETE FROM data.rasters WHERE snapshot_id = $1", [SNAPSHOT])
  await registerRasterSql(pool, { ...ref, crs: "ESRI:54009" })
  const srid = await pool.query("SELECT DISTINCT ST_SRID(rast) AS srid FROM data.rasters WHERE snapshot_id = $1", [
    SNAPSHOT
  ])
  assert.deepEqual(srid.rows, [{ srid: 54009 }])
})

test("cell size and lineage metadata are written at registration", async () => {
  // A new registration carries the value the store read and the artifact's metadata
  const run = await pool.query("SELECT run_id FROM app.raster_snapshots WHERE id = $1", [SNAPSHOT])
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await registerSnapshot(
      client,
      run.rows[0].run_id,
      { layerId: "rsql_layer", sources: [], timestamp: "2026-09-01T00:00:00Z", metadata: { release: "R2025A" } },
      { snapshotId: "22222222-2222-2222-2222-222222222222", sources: [], footprint: null, crs: "EPSG:4326", bandIds: ["v"], sizeBytes: 0, cellSizeM: 250 },
      "time-series"
    )
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  const registered = await pool.query("SELECT cell_size_m, metadata FROM app.raster_snapshots WHERE id = $1", [
    "22222222-2222-2222-2222-222222222222"
  ])
  assert.equal(Number(registered.rows[0].cell_size_m), 250)
  assert.deepEqual(registered.rows[0].metadata, { release: "R2025A" })

  // Metadata is lineage: an object of bounded size
  assert.throws(() => checkSnapshotMetadata({ layerId: "l", metadata: [] as never }), /must be a JSON object/)
  assert.throws(
    () => checkSnapshotMetadata({ layerId: "l", metadata: { blob: "x".repeat(SNAPSHOT_METADATA_MAX_BYTES) } }),
    /over the 65536-byte limit/
  )
  checkSnapshotMetadata({ layerId: "l", metadata: { release: "R2025A" } })
})

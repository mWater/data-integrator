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
import { refreshAoi, describeAoi } from "../src/aoi.js"
import { registerRasterSql } from "../src/rasterSql.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool
let storeDir: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({
    connectionString: db.url,
    options: "-c postgis.enable_outdb_rasters=on -c postgis.gdal_enabled_drivers=ENABLE_ALL"
  })
  await migrate(pool, MIGRATIONS_DIR)
  storeDir = await mkdtemp(path.join(tmpdir(), "aoi-test-"))
  await chmod(storeDir, 0o755)
})

after(async () => {
  await pool?.end()
  await db?.stop()
  if (storeDir) await rm(storeDir, { recursive: true, force: true })
})

test("refreshAoi builds a land-only shape for a country and clears it on null", async () => {
  await refreshAoi(pool, { bbox: [43.257, -25.571, 50.483, -12.08], countries: ["MDG"], name: "Madagascar" })
  const row = (await pool.query("SELECT name, countries, land_area_km2, boundary_version, ST_IsValid(geom) AS valid FROM data.aoi")).rows[0]
  assert.equal(row.name, "Madagascar")
  assert.deepEqual(row.countries, ["MDG"])
  assert.ok(row.valid)
  // Madagascar's land is about 587,000 km²; the box alone would be 1.1 million
  assert.ok(row.land_area_km2 > 570_000 && row.land_area_km2 < 610_000, `land area ${row.land_area_km2}`)
  assert.match(await describeAoi(pool) ?? "", /Madagascar: land area/)

  // A bare box is a rectangle with its own provenance
  await refreshAoi(pool, { bbox: [10, 0, 11, 1] })
  const box = (await pool.query("SELECT boundary_source, round(land_area_km2) AS km2 FROM data.aoi")).rows[0]
  assert.equal(box.boundary_source, "Bounding box")
  assert.ok(Number(box.km2) > 12_000 && Number(box.km2) < 12_500)

  await refreshAoi(pool, null)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM data.aoi")).rows[0].n, 0)
  assert.equal(await describeAoi(pool), null)
})

test("refreshAoi folds Somaliland into Somalia", async () => {
  await refreshAoi(pool, { bbox: [40.964, -1.695, 51.39, 11.984], countries: ["SOM"], name: "Somalia" })
  const row = (
    await pool.query(
      `SELECT land_area_km2, ST_IsValid(geom) AS valid,
              ST_Contains(geom, ST_SetSRID(ST_Point(44.065, 9.562), 4326)) AS hargeisa,
              ST_Contains(geom, ST_SetSRID(ST_Point(45.318, 2.046), 4326)) AS mogadishu
       FROM data.aoi`
    )
  ).rows[0]
  assert.ok(row.valid)
  assert.ok(row.hargeisa, "Hargeisa is inside the Somalia outline")
  assert.ok(row.mogadishu)
  // The whole country is about 637,000 km²; Natural Earth's Somalia alone is 472,000
  assert.ok(row.land_area_km2 > 620_000 && row.land_area_km2 < 660_000, `land area ${row.land_area_km2}`)
  await refreshAoi(pool, null)
})

test("aoi_stats weights coarse pixels by the part inside the boundary and reports coverage", async () => {
  // Area of interest: the left half of a 2x2-degree box, so a 2-pixel-wide
  // raster has one pixel fully inside and one straddling the edge
  await refreshAoi(pool, { bbox: [10, 0, 11, 2] })
  // Raster: 2 columns x 1 row over [10,0,12,2]; left pixel 3, right pixel 9,
  // built as two one-pixel files mosaicked through a VRT
  const left = path.join(storeDir, "left.tif")
  const right = path.join(storeDir, "right.tif")
  const vrt = path.join(storeDir, "two.vrt")
  const tif = path.join(storeDir, "two.tif")
  const onePixel = (file: string, value: string, west: string, east: string) =>
    execFileP("gdal_create", [
      "-of", "GTiff", "-outsize", "1", "1", "-bands", "1", "-burn", value,
      "-a_srs", "EPSG:4326", "-a_ullr", west, "2", east, "0", "-a_nodata", "-9999", file
    ])
  await onePixel(left, "3", "10", "11")
  await onePixel(right, "9", "11", "12")
  await execFileP("gdalbuildvrt", [vrt, left, right])
  await execFileP("gdal_translate", ["-q", vrt, tif])
  await chmod(tif, 0o644)

  // Integration and its version reference each other; the constraint is deferred
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("INSERT INTO app.integrations (id, definition, version) VALUES ('aoi_int', '{}', 1)")
    await client.query("INSERT INTO app.integration_versions (integration_id, version, definition) VALUES ('aoi_int', 1, '{}')")
    await client.query("COMMIT")
  } finally {
    client.release()
  }
  await pool.query(
    `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
     VALUES ('two', 'aoi_int', '{"_base":"en","en":"two"}', 'current-only', '[{"id":"v","nodata":-9999}]')`
  )
  const run = (
    await pool.query("INSERT INTO app.runs (integration_id, trigger, status) VALUES ('aoi_int', 'manual', 'succeeded') RETURNING id")
  ).rows[0].id
  const snap = (
    await pool.query(
      `INSERT INTO app.raster_snapshots (layer_id, observed_at, footprint, crs, bands, run_id, status)
       VALUES ('two', '2026-01-01T00:00:00Z', ST_GeomFromText('POLYGON((10 0, 12 0, 12 2, 10 2, 10 0))', 4326),
               'EPSG:4326', '["v"]', $1, 'promoted') RETURNING id`,
      [run]
    )
  ).rows[0].id
  await registerRasterSql(pool, {
    snapshotId: snap,
    layerId: "two",
    observedAt: "2026-01-01T00:00:00Z",
    observedEnd: null,
    crs: "EPSG:4326",
    absolutePaths: [tif]
  })

  const stats = (await pool.query("SELECT * FROM data.aoi_stats('two', NULL, 5, '>')")).rows[0]
  // Only the left pixel (value 3) lies inside the box [10,0,11,2]; the right
  // pixel touches it along an edge with zero area and must not count
  assert.equal(stats.method, "exact")
  assert.equal(Number(stats.cells), 1)
  assert.ok(Math.abs(Number(stats.mean) - 3) < 1e-9, `mean ${stats.mean}`)
  assert.equal(Number(stats.share), 0)
  assert.ok(Math.abs(Number(stats.coverage) - 1) < 1e-6, `coverage ${stats.coverage}`)

  // Half the box: the pixel is weighted by the half inside, coverage stays 1
  await refreshAoi(pool, { bbox: [10, 0, 10.5, 2] })
  const half = (await pool.query("SELECT * FROM data.aoi_stats('two', NULL, 2, '>')")).rows[0]
  assert.equal(Number(half.cells), 1)
  assert.equal(Number(half.share), 1)
  assert.ok(Math.abs(Number(half.coverage) - 1) < 1e-6, `coverage ${half.coverage}`)

  // The layer's map mask follows: its integration declares no aoi, so it
  // inherits the deployment shape, and loses it when the shape is cleared
  const masked = (await pool.query("SELECT ST_AsText(ST_Envelope(mask_geom)) AS env FROM app.raster_layers WHERE id = 'two'")).rows[0]
  assert.equal(masked.env, "POLYGON((10 0,10 2,10.5 2,10.5 0,10 0))")
  await refreshAoi(pool, null)
  const cleared = (await pool.query("SELECT mask_geom FROM app.raster_layers WHERE id = 'two'")).rows[0]
  assert.equal(cleared.mask_geom, null)
})

test("aoi_stats clip path weights whole pixels by their area at their latitude", async () => {
  // A box from the equator to 60N: cells near the equator are about twice
  // the area of cells near the top, so a plain pixel mean is visibly wrong
  await refreshAoi(pool, { bbox: [10, 0, 11, 60] })
  // 0.02-degree raster, value 3 south of 30N and 9 north of it: far more
  // than 25,000 cells, so the whole-pixel path runs
  const south = path.join(storeDir, "south.tif")
  const north = path.join(storeDir, "north.tif")
  const vrt = path.join(storeDir, "strip.vrt")
  const tif = path.join(storeDir, "strip.tif")
  const half = (file: string, value: string, top: string, bottom: string) =>
    execFileP("gdal_create", [
      "-of", "GTiff", "-outsize", "50", "1500", "-bands", "1", "-burn", value,
      "-a_srs", "EPSG:4326", "-a_ullr", "10", top, "11", bottom, "-a_nodata", "-9999", file
    ])
  await half(south, "3", "30", "0")
  await half(north, "9", "60", "30")
  await execFileP("gdalbuildvrt", [vrt, south, north])
  await execFileP("gdal_translate", ["-q", vrt, tif])
  await chmod(tif, 0o644)

  await pool.query(
    `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
     VALUES ('strip', 'aoi_int', '{"_base":"en","en":"strip"}', 'current-only', '[{"id":"v","nodata":-9999}]')`
  )
  const run = (
    await pool.query("INSERT INTO app.runs (integration_id, trigger, status) VALUES ('aoi_int', 'manual', 'succeeded') RETURNING id")
  ).rows[0].id
  const snap = (
    await pool.query(
      `INSERT INTO app.raster_snapshots (layer_id, observed_at, footprint, crs, bands, run_id, status)
       VALUES ('strip', '2026-01-01T00:00:00Z', ST_GeomFromText('POLYGON((10 0, 11 0, 11 60, 10 60, 10 0))', 4326),
               'EPSG:4326', '["v"]', $1, 'promoted') RETURNING id`,
      [run]
    )
  ).rows[0].id
  await registerRasterSql(pool, {
    snapshotId: snap,
    layerId: "strip",
    observedAt: "2026-01-01T00:00:00Z",
    observedEnd: null,
    crs: "EPSG:4326",
    absolutePaths: [tif]
  })

  const areas = (
    await pool.query(
      `SELECT ST_Area(ST_MakeEnvelope(10, 0, 11, 30, 4326)::geography) AS s,
              ST_Area(ST_MakeEnvelope(10, 30, 11, 60, 4326)::geography) AS n`
    )
  ).rows[0]
  const expectedMean = (3 * areas.s + 9 * areas.n) / (areas.s + areas.n)
  const expectedShare = areas.n / (areas.s + areas.n)

  const stats = (await pool.query("SELECT * FROM data.aoi_stats('strip', NULL, 5, '>')")).rows[0]
  assert.equal(stats.method, "clip")
  assert.equal(Number(stats.cells), 150_000)
  // An unweighted mean would be 6 and an unweighted share 0.5
  assert.ok(Math.abs(Number(stats.mean) - expectedMean) < 1e-3, `mean ${stats.mean}, expected ${expectedMean}`)
  assert.ok(Math.abs(Number(stats.share) - expectedShare) < 1e-3, `share ${stats.share}, expected ${expectedShare}`)
  assert.ok(Math.abs(Number(stats.coverage) - 1) < 1e-3, `coverage ${stats.coverage}`)
  await refreshAoi(pool, null)
})

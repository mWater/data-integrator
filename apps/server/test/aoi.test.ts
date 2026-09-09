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
})

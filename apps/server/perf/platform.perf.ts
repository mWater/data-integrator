/**
 * Basic performance tests: the operations a user waits on, timed against a
 * fixed synthetic dataset (100,000 point rows and one 2048 x 2048 raster over
 * Madagascar's extent).
 *
 * These are regression guards, not capacity tests. Each measurement has a
 * budget of at least eight times its time in CI (the baseline in
 * docs/Architecture.md), so a shared CI machine does not fail it at random
 * and a real regression still does. PERF_BUDGET_FACTOR scales
 * every budget (2 doubles them). Run with `pnpm perf`.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { Server } from "node:http"
import { AddressInfo } from "node:net"
import { cpus, tmpdir, totalmem } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import pg from "pg"
import { IntegrationDefinition, RasterLayerDestination, TableDestination } from "@data-integrator/definitions"
import { Runner } from "@mwater/integration-runner"
import { createApiToken, createUser } from "../src/auth.js"
import { registerSnapshot, storeArtifact } from "../src/catalog.js"
import { applyStagedTable, dropStagedTable, stageTableFile } from "../src/destinations.js"
import { installIntegration } from "../src/install.js"
import { migrate } from "../src/migrations.js"
import { registerRasterSql } from "../src/rasterSql.js"
import { RasterStore } from "../src/rasterStore.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { startTestDb, TestDb } from "../test/helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const ALPINE = "docker.io/library/alpine:3.20"

const ROWS = 100_000
const RASTER_SIZE = 2048
/** [west, south, east, north] of the synthetic data: Madagascar's extent. */
const EXTENT = [43, -26, 51, -11] as const
const BUDGET_FACTOR = Number(process.env.PERF_BUDGET_FACTOR ?? 1)

const TABLE: TableDestination = {
  kind: "table",
  tableId: "perf_sites",
  action: "replace",
  columns: [
    { id: "site", type: "text" },
    { id: "district", type: "text" },
    { id: "level", type: "number" },
    { id: "measured_on", type: "date" },
    { id: "geom", type: "geometry" }
  ]
}

const LAYER: RasterLayerDestination = {
  kind: "raster",
  layerId: "perf_rain",
  temporality: "time-series",
  bands: [
    {
      id: "mm",
      rendering: { colorMap: [{ value: 0, color: "#ffffff" }, { value: 100, color: "#08306b" }], resampling: "average" }
    }
  ]
}

const DEFINITION: IntegrationDefinition = {
  id: "perf_source",
  name: { _base: "en", en: "Performance fixture" },
  trigger: {},
  runtime: "python",
  destinations: [TABLE, LAYER],
  code: "",
  contract: 2
}

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const GDAL = await execFileP("ogr2ogr", ["--version"]).then(() => true, () => false)
const RUNSC = await access("/usr/local/bin/runsc").then(() => true, () => false)
/** The suite needs a database (podman or TEST_DATABASE_URL) and the GDAL tools. */
const AVAILABLE = (PODMAN || !!process.env.TEST_DATABASE_URL) && GDAL
/** The sandbox measurement also needs podman and gVisor. */
const SANDBOX = AVAILABLE && PODMAN && RUNSC

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let bearer: string
let workDir: string
let store: RasterStore
let snapshotId: string
let runner: Runner | null = null

/** One reported measurement. */
interface Measurement {
  /** The operation, as the report names it */
  name: string
  /** What the number is: one operation, or the median or 95th percentile of several */
  basis: string
  /** Measured time in milliseconds */
  ms: number
  /** Time above which the test fails, after PERF_BUDGET_FACTOR */
  budgetMs: number
  /** A second way to read the number, e.g. rows per second */
  note?: string
}
const measurements: Measurement[] = []

/** Milliseconds one call takes. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

/** Durations of n calls made one after another. */
async function repeat(n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(await timed(() => fn(i)))
  return out
}

/** The value at a percentile (0 to 100) of a list of durations. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/** Records a measurement and fails the test when it is over its budget. */
function report(name: string, basis: string, ms: number, budgetMs: number, note?: string): void {
  const scaled = budgetMs * BUDGET_FACTOR
  measurements.push({ name, basis, ms, budgetMs: scaled, note })
  assert.ok(ms <= scaled, `${name}: ${ms.toFixed(0)} ms is over its budget of ${scaled} ms`)
}

/** GET with the bearer token; the body is read so the whole response is timed. */
async function get(pathAndQuery: string): Promise<{ status: number; bytes: number }> {
  const res = await fetch(`${base}${pathAndQuery}`, { headers: { authorization: `Bearer ${bearer}` } })
  const body = await res.arrayBuffer()
  return { status: res.status, bytes: body.byteLength }
}

/** Deterministic pseudo-random numbers in [0, 1), so every run loads the same data. */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** Writes the point table as GeoJSON, the form a job hands the platform. */
async function writeTableFile(file: string): Promise<void> {
  const next = sequence(42)
  const [west, south, east, north] = EXTENT
  const features: string[] = []
  for (let i = 0; i < ROWS; i++) {
    const lon = (west + next() * (east - west)).toFixed(5)
    const lat = (south + next() * (north - south)).toFixed(5)
    const day = String(1 + Math.floor(next() * 28)).padStart(2, "0")
    features.push(
      `{"type":"Feature","properties":{"site":"site_${String(i).padStart(6, "0")}","district":"district_${Math.floor(next() * 100)}",` +
        `"level":${(next() * 50).toFixed(2)},"measured_on":"2026-01-${day}"},"geometry":{"type":"Point","coordinates":[${lon},${lat}]}}`
    )
  }
  await writeFile(file, `{"type":"FeatureCollection","features":[\n${features.join(",\n")}\n]}\n`)
}

/** Writes a Cloud-Optimized GeoTIFF of smoothly varying values over the extent. */
async function writeRasterFile(dir: string, file: string): Promise<void> {
  const [west, south, east, north] = EXTENT
  const values = new Float32Array(RASTER_SIZE * RASTER_SIZE)
  for (let row = 0; row < RASTER_SIZE; row++) {
    for (let col = 0; col < RASTER_SIZE; col++) {
      values[row * RASTER_SIZE + col] = 50 + 40 * Math.sin(col / 90) * Math.cos(row / 70)
    }
  }
  // A raw grid with a text header (GDAL's EHdr format), converted to a COG
  const raw = path.join(dir, "grid.bil")
  await writeFile(raw, Buffer.from(values.buffer))
  await writeFile(
    path.join(dir, "grid.hdr"),
    [
      `nrows ${RASTER_SIZE}`, `ncols ${RASTER_SIZE}`, "nbands 1", "nbits 32", "pixeltype float", "byteorder I", "layout bil",
      `ulxmap ${west + (east - west) / RASTER_SIZE / 2}`, `ulymap ${north - (north - south) / RASTER_SIZE / 2}`,
      `xdim ${(east - west) / RASTER_SIZE}`, `ydim ${(north - south) / RASTER_SIZE}`
    ].join("\n") + "\n"
  )
  await execFileP("gdal_translate", ["-q", "-of", "COG", "-a_srs", "EPSG:4326", "-co", "COMPRESS=DEFLATE", raw, file])
}

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({
    connectionString: db.url,
    options: "-c postgis.enable_outdb_rasters=on -c postgis.gdal_enabled_drivers=GTiff"
  })
  await migrate(pool, MIGRATIONS_DIR)
  await installIntegration(pool, DEFINITION)

  // Under tmpdir and world-readable: the database container mounts tmpdir and reads rasters from the store
  workDir = await mkdtemp(path.join(tmpdir(), "perf-"))
  await chmod(workDir, 0o755)
  store = new RasterStore(path.join(workDir, "store"))

  const user = await createUser(pool, "perf@example.org", "perf-password-1", "viewer")
  bearer = await createApiToken(pool, user.id, "perf")
  server = createApiServer(pool, new TileRenderer(store, path.join(workDir, "tile-cache")))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, { timeout: 180_000 })

after(async () => {
  if (!AVAILABLE) return
  server?.close()
  await runner?.teardown().catch(() => {})
  await pool?.end()
  await db?.stop()
  await rm(workDir, { recursive: true, force: true })

  const lines = [
    "| Operation | Measured | Time | Budget | |",
    "|---|---|---:|---:|---|",
    ...measurements.map(m => `| ${m.name} | ${m.basis} | ${m.ms.toFixed(0)} ms | ${m.budgetMs} ms | ${m.note ?? ""} |`)
  ]
  const setting = `${ROWS.toLocaleString("en")} rows, ${RASTER_SIZE} x ${RASTER_SIZE} raster, on ${cpus().length} CPUs and ${Math.round(totalmem() / 2 ** 30)} GB`
  console.log(`\nPerformance baseline (${setting})\n${lines.join("\n")}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Performance baseline\n\n${setting}\n\n${lines.join("\n")}\n`)
  }
})

test("tabular load: a job's table file into the database", { skip: !AVAILABLE }, async () => {
  const file = path.join(workDir, "sites.geojson")
  await writeTableFile(file)
  const runId = randomUUID()
  let loaded = 0
  const ms = await timed(async () => {
    // The executor's sequence for one table file: stage, apply, drop staging
    const staged = await stageTableFile(pool, db.url, TABLE, file, "geojson", runId)
    try {
      loaded = await applyStagedTable(pool as unknown as pg.ClientBase, staged, runId)
    } finally {
      await dropStagedTable(pool, staged)
    }
  })
  assert.equal(loaded, ROWS)
  report("Tabular load", `${ROWS.toLocaleString("en")} rows, once`, ms, 30_000, `${Math.round(ROWS / (ms / 1000)).toLocaleString("en")} rows/s`)
}, { timeout: 300_000 })

test("query API: a filtered, ordered page of rows", { skip: !AVAILABLE }, async () => {
  const where = encodeURIComponent(JSON.stringify([{ column: "level", op: ">", value: 25 }]))
  const page = (i: number) => `/api/tables/perf_sites/rows?where=${where}&order=site&limit=100&offset=${i * 100}`
  assert.equal((await get(page(0))).status, 200)
  const times = await repeat(50, async i => assert.equal((await get(page(i))).status, 200))
  report("Query API, one page", "median of 50", percentile(times, 50), 500)
  report("Query API, one page", "95th percentile of 50", percentile(times, 95), 1_000)

  const together = await timed(() => Promise.all(Array.from({ length: 20 }, (_, i) => get(page(i)))))
  report("Query API, 20 at once", "all 20 answered", together, 5_000)
}, { timeout: 120_000 })

test("vector tiles of the table", { skip: !AVAILABLE }, async () => {
  // Zoom 7 tiles across the extent: x 79 to 82, y 68 to 73
  const tiles = [79, 80, 81, 82].flatMap(x => [68, 69, 70, 71, 72].map(y => `/api/tables/perf_sites/tiles/7/${x}/${y}.mvt`))
  let bytes = 0
  const times = await repeat(tiles.length, async i => {
    const res = await get(tiles[i])
    assert.ok(res.status === 200 || res.status === 204, `${tiles[i]}: ${res.status}`)
    bytes += res.bytes
  })
  assert.ok(bytes > 0, "at least one tile holds features")
  report("Vector tile", `median of ${tiles.length}`, percentile(times, 50), 1_500)
}, { timeout: 120_000 })

test("raster load: a job's raster into the store and the database", { skip: !AVAILABLE }, async () => {
  const outDir = path.join(workDir, "out")
  await execFileP("mkdir", ["-p", outDir])
  await writeRasterFile(workDir, path.join(outDir, "rain.tif"))
  const artifact = { layerId: LAYER.layerId, path: "rain.tif", timestamp: "2026-01-01T00:00:00Z" }
  const run = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status) VALUES ($1, 'manual', 'succeeded') RETURNING id`,
    [DEFINITION.id]
  )
  const ms = await timed(async () => {
    // The executor's sequence for one raster: store, catalog, register for SQL
    const stored = await storeArtifact(store, outDir, artifact, ["mm"])
    snapshotId = stored.snapshotId
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await registerSnapshot(client, run.rows[0].id, artifact, stored, "time-series")
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
    await registerRasterSql(pool, {
      snapshotId,
      layerId: LAYER.layerId,
      observedAt: artifact.timestamp,
      observedEnd: null,
      crs: stored.crs,
      absolutePaths: stored.sources.map(s => store.absolute(s.relPath))
    })
  })
  report("Raster load", `${RASTER_SIZE} x ${RASTER_SIZE} cells, once`, ms, 10_000)
}, { timeout: 180_000 })

test("raster map tiles: first render, then the cached copy", { skip: !AVAILABLE }, async () => {
  const tiles = [39, 40, 41].flatMap(x => [34, 35, 36].map(y => `/tiles/${LAYER.layerId}/${snapshotId}/6/${x}/${y}.png`))
  const first = await repeat(tiles.length, async i => assert.equal((await get(tiles[i])).status, 200, tiles[i]))
  report("Raster tile, first render", `median of ${tiles.length}`, percentile(first, 50), 3_000)
  const cached = await repeat(tiles.length, async i => assert.equal((await get(tiles[i])).status, 200))
  report("Raster tile, cached", `median of ${tiles.length}`, percentile(cached, 50), 250)
}, { timeout: 180_000 })

test("zonal statistics: the raster averaged over 100 polygons in SQL", { skip: !AVAILABLE }, async () => {
  // A 10 x 10 grid of half-degree squares inside the extent, each clipped from the raster tiles it touches
  const sql = `
    WITH zones AS (
      SELECT i * 10 + j AS id, ST_MakeEnvelope(44 + i * 0.6, -25 + j * 1.3, 44.5 + i * 0.6, -24.5 + j * 1.3, 4326) AS geom
      FROM generate_series(0, 9) i, generate_series(0, 9) j
    )
    SELECT z.id, (ST_SummaryStats(ST_Union(ST_Clip(r.rast, z.geom)))).mean AS mean
    FROM zones z JOIN data.rasters r ON r.snapshot_id = $1 AND ST_Intersects(ST_ConvexHull(r.rast), z.geom)
    GROUP BY z.id`
  const warm = await pool.query(sql, [snapshotId])
  assert.equal(warm.rows.length, 100)
  assert.ok(warm.rows.every(r => Number(r.mean) > 0 && Number(r.mean) < 100))
  const times = await repeat(5, () => pool.query(sql, [snapshotId]))
  report("Zonal statistics, 100 polygons", "median of 5", percentile(times, 50), 20_000)
}, { timeout: 300_000 })

test("sandbox: starting a job that does nothing", { skip: !SANDBOX }, async () => {
  await execFileP("podman", ["pull", "-q", ALPINE])
  runner = new Runner({ network: "integrator-jobs-perf" })
  await runner.ensureReady()
  const job = async () => {
    const result = await runner!.run({ image: ALPINE, payload: null, command: ["true"] })
    assert.equal(result.status, "succeeded", result.stderrTail)
  }
  await job()
  const times = await repeat(5, job)
  report("Sandbox job start to finish", "median of 5", percentile(times, 50), 15_000)
}, { timeout: 300_000 })

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration, validateDefinition } from "../src/install.js"
import { RasterStore } from "../src/rasterStore.js"
import { pruneSnapshots } from "../src/retention.js"
import { TileRenderer } from "../src/tiles.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool
let store: RasterStore
let tiles: TileRenderer
let cacheDir: string
let runId: string

/** One integration owning a layer of each retention shape. */
const DEFINITION: IntegrationDefinition = {
  id: "ret_source",
  name: { _base: "en", en: "Retention source" },
  trigger: {},
  runtime: "python",
  destinations: [
    { kind: "raster", layerId: "ret_window", temporality: "time-series", retention: { days: 30 }, bands: [{ id: "v" }] },
    { kind: "raster", layerId: "ret_stale", temporality: "time-series", retention: { days: 30 }, bands: [{ id: "v" }] },
    { kind: "raster", layerId: "ret_forever", temporality: "time-series", bands: [{ id: "v" }] },
    { kind: "raster", layerId: "ret_current", temporality: "current-only", bands: [{ id: "v" }] }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

/** Inserts a snapshot with one stored file and one cached tile; returns its id. */
async function snapshot(
  layerId: string,
  daysAgo: number,
  opts: { status?: string; endDaysAgo?: number } = {}
): Promise<string> {
  const observedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  const observedEnd = opts.endDaysAgo === undefined ? null : new Date(Date.now() - opts.endDaysAgo * 86_400_000).toISOString()
  const inserted = await pool.query(
    `INSERT INTO app.raster_snapshots (id, layer_id, observed_at, observed_end, footprint, crs, bands, run_id, status)
     VALUES (gen_random_uuid(), $1, $2, $3, ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326),
             'EPSG:4326', '["v"]', $4, $5)
     RETURNING id`,
    [layerId, observedAt, observedEnd, runId, opts.status ?? "promoted"]
  )
  const id = inserted.rows[0].id as string
  const relPath = `${layerId}/${id}/0.tif`
  await mkdir(path.dirname(store.absolute(relPath)), { recursive: true })
  await writeFile(store.absolute(relPath), "tif")
  await pool.query(
    `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint)
     VALUES ($1, 0, $2, ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326))`,
    [id, relPath]
  )
  await mkdir(path.join(cacheDir, layerId, id, "default", "0", "0"), { recursive: true })
  await writeFile(path.join(cacheDir, layerId, id, "default", "0", "0", "0.png"), "png")
  return id
}

const exists = (p: string) => access(p).then(() => true, () => false)
const remaining = async () =>
  new Set((await pool.query("SELECT id FROM app.raster_snapshots")).rows.map(r => r.id as string))

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  store = new RasterStore(await mkdtemp(path.join(tmpdir(), "ret-store-")))
  cacheDir = await mkdtemp(path.join(tmpdir(), "ret-tiles-"))
  tiles = new TileRenderer(store, cacheDir)
  await installIntegration(pool, DEFINITION)
  const run = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('ret_source', 'manual', 'succeeded') RETURNING id"
  )
  runId = run.rows[0].id
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool?.end()
  await db?.stop()
})

test("retention is validated: time-series only, whole days", () => {
  const withRetention = (temporality: "time-series" | "current-only", days: number): IntegrationDefinition => ({
    ...DEFINITION,
    destinations: [{ kind: "raster", layerId: "x", temporality, retention: { days }, bands: [{ id: "v" }] }]
  })
  assert.throws(() => validateDefinition(withRetention("current-only", 30)), /needs temporality "time-series"/)
  assert.throws(() => validateDefinition(withRetention("time-series", 0)), /at least 1/)
  assert.throws(() => validateDefinition(withRetention("time-series", 1.5)), /whole number/)
  validateDefinition(withRetention("time-series", 365))
})

test("install copies retention.days onto the layer row", { skip: !AVAILABLE }, async () => {
  const layers = await pool.query("SELECT id, retention_days FROM app.raster_layers ORDER BY id")
  assert.deepEqual(
    Object.fromEntries(layers.rows.map(r => [r.id, r.retention_days])),
    { ret_current: null, ret_forever: null, ret_stale: 30, ret_window: 30 }
  )
})

test("sweep deletes expired and superseded snapshots with files and tiles, keeps the rest", { skip: !AVAILABLE }, async () => {
  const expired = await snapshot("ret_window", 100)
  const recent = await snapshot("ret_window", 10)
  const future = await snapshot("ret_window", -365)
  // Observation started before the window but ended inside it
  const straddling = await snapshot("ret_window", 40, { endDaysAgo: 20 })
  // A layer whose only snapshot is old: it stays as the current picture
  const staleCurrent = await snapshot("ret_stale", 100)
  // No retention: history is kept forever
  const forever = await snapshot("ret_forever", 1000)
  const replaced = await snapshot("ret_current", 50, { status: "superseded" })
  const live = await snapshot("ret_current", 5)
  await pool.query(
    `UPDATE app.raster_layers SET current_snapshot_id = CASE id
       WHEN 'ret_window' THEN $1::uuid WHEN 'ret_stale' THEN $2::uuid
       WHEN 'ret_forever' THEN $3::uuid WHEN 'ret_current' THEN $4::uuid END`,
    [recent, staleCurrent, forever, live]
  )

  const result = await pruneSnapshots(pool, store, tiles)
  assert.deepEqual(result, { snapshots: 2, superseded: 1 })

  const left = await remaining()
  for (const id of [recent, future, straddling, staleCurrent, forever, live]) assert.ok(left.has(id), `kept ${id}`)
  for (const id of [expired, replaced]) assert.ok(!left.has(id), `deleted ${id}`)

  assert.equal(await exists(store.absolute(`ret_window/${expired}`)), false, "expired files removed")
  assert.equal(await exists(path.join(cacheDir, "ret_window", expired)), false, "expired tiles removed")
  assert.equal(await exists(store.absolute(`ret_current/${replaced}`)), false, "superseded files removed")
  assert.equal(await exists(store.absolute(`ret_window/${recent}/0.tif`)), true, "kept files untouched")
  assert.equal(await exists(path.join(cacheDir, "ret_window", recent)), true, "kept tiles untouched")
  const sources = await pool.query("SELECT count(*)::int AS n FROM app.raster_sources WHERE snapshot_id = ANY($1)", [
    [expired, replaced]
  ])
  assert.equal(sources.rows[0].n, 0, "sources cascade")

  // Nothing left to do: a second sweep is a no-op
  assert.deepEqual(await pruneSnapshots(pool, store, tiles), { snapshots: 0, superseded: 0 })
})

test("sweep works through more than one batch", { skip: !AVAILABLE }, async () => {
  for (let i = 0; i < 205; i++) await snapshot("ret_window", 60 + i)
  const result = await pruneSnapshots(pool, store, tiles)
  assert.equal(result.snapshots, 205)
})

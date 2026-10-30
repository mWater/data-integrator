import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { createUser } from "../src/auth.js"
import { advanceCurrentPointers } from "../src/catalog.js"
import { installIntegration } from "../src/install.js"
import { migrate } from "../src/migrations.js"
import { RasterStore } from "../src/rasterStore.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let cookie: string
let snapshotId: string

/** Two bands, so band selection has something to choose between. */
const LAYERED: IntegrationDefinition = {
  id: "layer_src",
  name: { _base: "en", en: "Layer source" },
  trigger: {},
  runtime: "python",
  destinations: [
    {
      kind: "raster",
      layerId: "drought",
      name: { _base: "en", en: "Drought indices" },
      temporality: "time-series",
      bands: [
        { id: "spei3", name: { _base: "en", en: "SPEI-3" }, units: "index", rendering: { colorMap: [{ value: 0, color: "#fff" }] } },
        { id: "spei6", name: { _base: "en", en: "SPEI-6" }, units: "index" }
      ]
    }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  await createUser(pool, "root@example.org", "rootpw-123456", "admin")
  await installIntegration(pool, LAYERED)

  const run = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('layer_src', 'manual', 'succeeded') RETURNING id"
  )
  const snapshot = await pool.query(
    `INSERT INTO app.raster_snapshots
       (layer_id, observed_at, footprint, crs, bands, size_bytes, run_id, status)
     VALUES ('drought', now(), ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326),
             'EPSG:4326', $1, 1024, $2, 'promoted')
     RETURNING id`,
    [JSON.stringify(LAYERED.destinations[0].bands), run.rows[0].id]
  )
  snapshotId = snapshot.rows[0].id
  await pool.query(
    `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint, size_bytes)
     VALUES ($1, 0, 'drought/a.tif', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326), 1024)`,
    [snapshotId]
  )
  await pool.query("UPDATE app.raster_layers SET current_snapshot_id = $1 WHERE id = 'drought'", [snapshotId])

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "root@example.org", password: "rootpw-123456" })
  })
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]
})

after(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
  await pool?.end()
  await db?.stop()
})

test("layer detail carries bands, snapshots and provenance", async () => {
  const res = await fetch(`${base}/api/layers/drought`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const layer = await res.json()
  assert.equal(layer.id, "drought")
  assert.deepEqual(layer.name, { _base: "en", en: "Drought indices" })
  assert.equal(layer.integrationId, "layer_src")
  assert.deepEqual(layer.integrationName, { _base: "en", en: "Layer source" })
  assert.equal(layer.temporality, "time-series")
  assert.deepEqual(layer.bands.map((b: { id: string }) => b.id), ["spei3", "spei6"])
  assert.equal(layer.snapshots.length, 1)
  assert.equal(layer.currentSnapshotId, snapshotId)
  assert.equal(layer.crs, "EPSG:4326")
  assert.equal(layer.sizeBytes, 1024)
  assert.ok(layer.footprint)
})

test("STAC: landing, collection and items describe the catalog with absolute links", async () => {
  const get = async (pathname: string) => {
    const res = await fetch(`${base}${pathname}`, { headers: { cookie } })
    return { status: res.status, type: res.headers.get("content-type"), body: await res.json() }
  }
  const stac = `${base}/api/stac`

  const landing = await get("/api/stac")
  assert.equal(landing.body.type, "Catalog")
  assert.ok(landing.body.conformsTo.includes("https://api.stacspec.org/v1.0.0/core"))
  assert.ok(landing.body.links.some((l: { rel: string; href: string }) => l.rel === "child" && l.href === `${stac}/collections/drought`))

  const collection = (await get("/api/stac/collections/drought")).body
  assert.equal(collection.type, "Collection")
  assert.equal(collection.title, "Drought indices")
  assert.deepEqual(collection.extent.spatial.bbox, [[0, 0, 1, 1]])
  assert.deepEqual(collection.summaries.bands.map((b: { name: string }) => b.name), ["spei3", "spei6"])
  assert.equal((await get("/api/stac/collections")).body.collections.length, 1)

  const items = await get("/api/stac/collections/drought/items")
  assert.equal(items.type, "application/geo+json")
  assert.equal(items.body.numberReturned, 1)
  const feature = items.body.features[0]
  assert.equal(feature.id, snapshotId)
  assert.deepEqual(feature.bbox, [0, 0, 1, 1])
  assert.equal(feature.assets.data.href, `${base}/api/snapshots/${snapshotId}/download`)
  assert.deepEqual((await get(`/api/stac/collections/drought/items/${snapshotId}`)).body.id, snapshotId)

  // Filters exclude, bad parameters are 400, unknown ids 404
  assert.equal((await get("/api/stac/collections/drought/items?datetime=2000-01-01T00:00:00Z/2000-12-31T00:00:00Z")).body.numberReturned, 0)
  assert.equal((await get("/api/stac/collections/drought/items?bbox=10,10,11,11")).body.numberReturned, 0)
  assert.equal((await get("/api/stac/collections/drought/items?bbox=0.5,0.5,2,2")).body.numberReturned, 1)
  assert.equal((await get("/api/stac/collections/drought/items?datetime=yesterday")).status, 400)
  assert.equal((await get("/api/stac/collections/nope")).status, 404)
  assert.equal((await fetch(`${stac}`)).status, 401)
})

test("current snapshot is the newest whose time has arrived, not the furthest projection", async () => {
  const run = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('layer_src', 'manual', 'succeeded') RETURNING id"
  )
  const insert = async (observedAt: string) =>
    (
      await pool.query(
        `INSERT INTO app.raster_snapshots (layer_id, observed_at, crs, bands, size_bytes, run_id, status)
         VALUES ('drought', $1, 'EPSG:4326', '[]', 0, $2, 'promoted') RETURNING id`,
        [observedAt, run.rows[0].id]
      )
    ).rows[0].id as string
  const lastYear = await insert("2025-01-01T00:00:00Z")
  const nextYear = await insert("2999-01-01T00:00:00Z")
  const later = await insert("3000-01-01T00:00:00Z")

  // The fixture's now() snapshot is the newest past one and stays current
  assert.equal(await advanceCurrentPointers(pool, "drought"), 0)
  let layer = await pool.query("SELECT current_snapshot_id FROM app.raster_layers WHERE id = 'drought'")
  assert.equal(layer.rows[0].current_snapshot_id, snapshotId)

  // With only future snapshots left, the nearest one is current
  await pool.query("UPDATE app.raster_snapshots SET status = 'superseded' WHERE id = ANY($1)", [[snapshotId, lastYear]])
  assert.equal(await advanceCurrentPointers(pool), 1)
  layer = await pool.query("SELECT current_snapshot_id FROM app.raster_layers WHERE id = 'drought'")
  assert.equal(layer.rows[0].current_snapshot_id, nextYear)

  // Restore the fixture: repromote, re-point, then drop the extras
  await pool.query("UPDATE app.raster_snapshots SET status = 'promoted' WHERE id = $1", [snapshotId])
  assert.equal(await advanceCurrentPointers(pool, "drought"), 1)
  await pool.query("DELETE FROM app.raster_snapshots WHERE id = ANY($1)", [[lastYear, nextYear, later]])
})

test("layer detail 404s for unknown ids and for catalog/session mismatches", async () => {
  const missing = await fetch(`${base}/api/layers/no_such_layer`, { headers: { cookie } })
  assert.equal(missing.status, 404)
  // The layer is installed, not scratch, so a session scope must not find it
  const scoped = await fetch(`${base}/api/layers/drought?session=${crypto.randomUUID()}`, { headers: { cookie } })
  assert.equal(scoped.status, 404)
})

test("layer detail requires a session", async () => {
  assert.equal((await fetch(`${base}/api/layers/drought`)).status, 401)
})

test("sample reads a pixel or rejects a bad request", async () => {
  assert.equal((await fetch(`${base}/api/layers/drought/sample?lon=0&lat=0&snapshot=${snapshotId}`)).status, 401)

  const missing = await fetch(`${base}/api/layers/drought/sample`, { headers: { cookie } })
  assert.equal(missing.status, 400)

  const unknown = await fetch(
    `${base}/api/layers/drought/sample?lon=0&lat=0&snapshot=00000000-0000-0000-0000-000000000000`,
    { headers: { cookie } }
  )
  assert.equal(unknown.status, 404)

  const unknownBand = await fetch(
    `${base}/api/layers/drought/sample?lon=0&lat=0&snapshot=${snapshotId}&band=nope`,
    { headers: { cookie } }
  )
  assert.equal(unknownBand.status, 404)

  // The fixture snapshot has no COG on disk, so the read is empty rather than an error
  const empty = await fetch(
    `${base}/api/layers/drought/sample?lon=0.5&lat=0.5&snapshot=${snapshotId}&band=spei3`,
    { headers: { cookie } }
  )
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { value: null })
})

/**
 * The band segment is optional in the tile path, so /:snapshot/:z/:x/:y and
 * /:snapshot/:band/:z/:x/:y have to stay distinguishable. Rendering needs GDAL
 * and a real COG, so these assert on how far the request gets: an unknown band
 * is rejected before rendering, a known one is not.
 */
test("tile paths resolve the band segment without swallowing the zoom", async () => {
  const unknown = await fetch(`${base}/tiles/drought/${snapshotId}/nope/3/4/5.png`, { headers: { cookie } })
  assert.equal(unknown.status, 404)
  assert.match((await unknown.json()).error, /unknown band "nope"/)

  // A digit-leading segment can only be the zoom, so this is the bandless form
  // and must resolve to the first band rather than 404 as an unknown band
  const bandless = await fetch(`${base}/tiles/drought/${snapshotId}/3/4/5.png`, { headers: { cookie } })
  assert.notEqual(bandless.status, 404)

  const named = await fetch(`${base}/tiles/drought/${snapshotId}/spei6/3/4/5.png`, { headers: { cookie } })
  assert.notEqual(named.status, 404)

  const unknownSnapshot = await fetch(
    `${base}/tiles/drought/00000000-0000-0000-0000-000000000000/spei3/3/4/5.png`,
    { headers: { cookie } }
  )
  assert.equal(unknownSnapshot.status, 404)
  assert.match((await unknownSnapshot.json()).error, /unknown snapshot/)
})

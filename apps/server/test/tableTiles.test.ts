import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import pg from "pg"
import { fileURLToPath } from "node:url"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { installIntegration } from "../src/install.js"
import { ensureTable } from "../src/destinations.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { IntegrationDefinition, TableDestination } from "@data-integrator/definitions"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** A destination with geometry and one without. */
const GEO_TABLE: TableDestination = {
  kind: "table",
  tableId: "geo_sites",
  action: "replace",
  columns: [
    { id: "name", type: "text" },
    { id: "location", type: "geometry" }
  ]
}
const PLAIN_TABLE: TableDestination = {
  kind: "table",
  tableId: "plain_rows",
  action: "replace",
  columns: [{ id: "name", type: "text" }]
}
const DEFINITION: IntegrationDefinition = {
  id: "tiles_demo",
  name: { _base: "en", en: "Tiles demo" },
  trigger: {},
  runtime: "node",
  destinations: [GEO_TABLE, PLAIN_TABLE],
  code: "export default async function run() { return {} }",
  contract: 2
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let bearer: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)

  const viewer = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  bearer = await createApiToken(pool, viewer.id, "viewer-token")

  await installIntegration(pool, DEFINITION)
  const client = await pool.connect()
  try {
    await ensureTable(client, GEO_TABLE)
    await ensureTable(client, PLAIN_TABLE)
  } finally {
    client.release()
  }
  await pool.query(`
    INSERT INTO data.geo_sites (name, location, _run_id) VALUES
      ('Antananarivo', ST_SetSRID(ST_Point(47.5214, -18.9101), 4326), gen_random_uuid()),
      ('Toliara', ST_SetSRID(ST_Point(43.6764, -23.3568), 4326), gen_random_uuid())
  `)

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
})

function call(pathname: string): Promise<Response> {
  return fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${bearer}` } })
}

test("geometry facts: column and extent, none for plain tables, 404 unknown", async () => {
  const geo = await (await call("/api/tables/geo_sites/geometry")).json()
  assert.equal(geo.geometryColumn, "location")
  assert.ok(Math.abs(geo.extent[0] - 43.6764) < 1e-6 && Math.abs(geo.extent[3] - -18.9101) < 1e-6)

  const plain = await (await call("/api/tables/plain_rows/geometry")).json()
  assert.deepEqual(plain, { geometryColumn: null, extent: null })

  assert.equal((await call("/api/tables/nope/geometry")).status, 404)
})

test("table tiles: features with properties where data is, empty elsewhere", async () => {
  // z6 x40 y35 covers Antananarivo
  const hit = await call("/api/tables/geo_sites/tiles/6/40/35.mvt")
  assert.equal(hit.status, 200)
  assert.equal(hit.headers.get("content-type"), "application/vnd.mapbox-vector-tile")
  const body = Buffer.from(await hit.arrayBuffer())
  assert.ok(body.length > 20, "tile carries features")
  assert.match(body.toString("latin1"), /Antananarivo/)
  assert.doesNotMatch(body.toString("latin1"), /Toliara/)

  // Empty ocean tile is a valid, empty MVT
  const miss = await call("/api/tables/geo_sites/tiles/6/10/35.mvt")
  assert.equal(miss.status, 200)
  assert.ok(Buffer.from(await miss.arrayBuffer()).length < 20)

  // No geometry, no tiles; bad coordinates are a 400
  assert.equal((await call("/api/tables/plain_rows/tiles/6/40/35.mvt")).status, 404)
  assert.equal((await call("/api/tables/geo_sites/tiles/6/999/35.mvt")).status, 400)
})

test("tiles require authentication", async () => {
  const anon = await fetch(`${base}/api/tables/geo_sites/tiles/6/40/35.mvt`)
  assert.equal(anon.status, 401)
})

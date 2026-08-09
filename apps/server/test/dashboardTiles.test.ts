import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { executeTileQuery, validateQueries, DashboardQuery } from "../src/dashboards/queries.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

/** Slippy tile x/y containing a lon/lat at a zoom. */
function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const x = Math.floor(((lon + 180) / 360) * 2 ** z)
  const rad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
  return { x, y }
}

/** Fixture points: a cluster near Antananarivo, Madagascar. */
const LON = 47.5
const LAT = -18.9

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let bearer: string

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)

  // Fixture table straight in the data schema; default privileges from the
  // migration give sql_engine SELECT on it. Drop first: a TEST_DATABASE_URL
  // database persists between runs.
  await pool.query("DROP TABLE IF EXISTS data.tile_pts")
  await pool.query("UPDATE app.dashboards SET current_version = NULL WHERE id = 'tiledash'")
  await pool.query("DELETE FROM app.dashboard_versions WHERE dashboard_id = 'tiledash'")
  await pool.query("DELETE FROM app.dashboards WHERE id = 'tiledash'")
  await pool.query(
    "DELETE FROM app.api_tokens WHERE user_id IN (SELECT id FROM app.users WHERE email = 'tiles@example.org')"
  )
  await pool.query("DELETE FROM app.users WHERE email = 'tiles@example.org'")
  await pool.query(`
    CREATE TABLE data.tile_pts (
      name text,
      kind text,
      geom geometry(Point, 4326)
    )`)
  await pool.query("CREATE INDEX ON data.tile_pts USING gist (geom)")
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO data.tile_pts (name, kind, geom)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326))`,
      [`pt_${i}`, i % 2 === 0 ? "well" : "spring", LON + (i % 5) * 0.001, LAT + Math.floor(i / 5) * 0.001]
    )
  }

  // A saved dashboard with one tile query and one plain query, inserted
  // directly (the build pipeline is exercised elsewhere)
  const queries: DashboardQuery[] = [
    {
      name: "sites",
      sql: "SELECT geom, name, kind FROM tile_pts WHERE ($1::text IS NULL OR kind = $1)",
      params: [{ name: "kind", type: "text" }],
      tile: true
    },
    { name: "counts", sql: "SELECT count(*)::int AS n FROM tile_pts", params: [] }
  ]
  await pool.query("INSERT INTO app.dashboards (id, name) VALUES ('tiledash', 'Tile dash')")
  await pool.query(
    `INSERT INTO app.dashboard_versions
       (dashboard_id, version, source, queries, kit_version, bundle_js, bundle_css)
     VALUES ('tiledash', 1, 'export default () => null', $1, '2', '', '')`,
    [JSON.stringify(queries)]
  )
  await pool.query("UPDATE app.dashboards SET current_version = 1 WHERE id = 'tiledash'")

  const user = await createUser(pool, "tiles@example.org", "hunter2hunter2", "viewer")
  bearer = await createApiToken(pool, user.id, "tile-token")

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  server?.close()
  await pool?.end()
  await db?.stop()
})

test("validateQueries accepts tile queries and guards the zoom param", () => {
  assert.deepEqual(
    validateQueries([{ name: "t", sql: "SELECT geom FROM x", params: [], tile: true }]),
    []
  )
  assert.deepEqual(
    validateQueries([
      { name: "t", sql: "SELECT geom FROM x", params: [{ name: "zoom", type: "integer" }], tile: true }
    ]),
    []
  )
  const badType = validateQueries([
    { name: "t", sql: "SELECT 1", params: [{ name: "zoom", type: "text" }], tile: true }
  ])
  assert.match(badType.join("\n"), /zoom.*integer/)
  const badRequired = validateQueries([
    { name: "t", sql: "SELECT 1", params: [{ name: "zoom", type: "integer", required: true }], tile: true }
  ])
  assert.match(badRequired.join("\n"), /server-bound/)
  const badFlag = validateQueries([{ name: "t", sql: "SELECT 1", params: [], tile: "yes" as never }])
  assert.match(badFlag.join("\n"), /tile must be a boolean/)
})

test("tile covering the data has features; empty tile is zero bytes", { skip: !AVAILABLE }, async () => {
  const query: DashboardQuery = {
    name: "sites",
    sql: "SELECT geom, name, kind FROM tile_pts",
    params: [],
    tile: true
  }
  const z = 12
  const { x, y } = tileAt(LON, LAT, z)
  const mvt = await executeTileQuery(pool, query, {}, z, x, y)
  assert.ok(mvt.length > 0, "covering tile has bytes")
  // The MVT layer is named after the query, and attributes ride along
  assert.ok(mvt.includes("sites"), "layer named after the query")
  assert.ok(mvt.includes("name"), "attribute key encoded")
  assert.ok(mvt.includes("pt_0"), "attribute value encoded")

  const empty = await executeTileQuery(pool, query, {}, z, 0, 0)
  assert.equal(empty.length, 0, "tile far from the data is empty")
})

test("declared parameters bind; the zoom param is server-bound", { skip: !AVAILABLE }, async () => {
  const query: DashboardQuery = {
    name: "lod",
    sql: "SELECT geom, kind FROM tile_pts WHERE $1 >= 10 AND ($2::text IS NULL OR kind = $2)",
    params: [
      { name: "zoom", type: "integer" },
      { name: "kind", type: "text" }
    ],
    tile: true
  }
  const deep = tileAt(LON, LAT, 12)
  const shallow = tileAt(LON, LAT, 5)
  const atDeep = await executeTileQuery(pool, query, {}, 12, deep.x, deep.y)
  assert.ok(atDeep.length > 0, "zoom 12 satisfies the LOD filter")
  const atShallow = await executeTileQuery(pool, query, {}, 5, shallow.x, shallow.y)
  assert.equal(atShallow.length, 0, "zoom 5 filtered out by the bound zoom")

  // Assert on kind values: MVT interns strings, so a filtered tile must not
  // contain the excluded value at all
  const wells = await executeTileQuery(pool, query, { kind: "well" }, 12, deep.x, deep.y)
  const springs = await executeTileQuery(pool, query, { kind: "spring" }, 12, deep.x, deep.y)
  assert.ok(wells.length > 0 && springs.length > 0)
  assert.ok(wells.includes("well") && !wells.includes("spring"), "kind filter applies")
  assert.ok(springs.includes("spring") && !springs.includes("well"))
})

test("query without a geom column fails with a pointed message", { skip: !AVAILABLE }, async () => {
  const query: DashboardQuery = { name: "bad", sql: "SELECT name FROM tile_pts", params: [], tile: true }
  await assert.rejects(
    executeTileQuery(pool, query, {}, 5, 0, 0),
    /must select a geometry column named "geom"/
  )
})

test("tile coordinates are validated", { skip: !AVAILABLE }, async () => {
  const query: DashboardQuery = { name: "sites", sql: "SELECT geom FROM tile_pts", params: [], tile: true }
  await assert.rejects(executeTileQuery(pool, query, {}, -1, 0, 0), /bad tile zoom/)
  await assert.rejects(executeTileQuery(pool, query, {}, 3, 8, 0), /bad tile coordinates/)
  await assert.rejects(executeTileQuery(pool, query, {}, 3, 0, 1.5), /bad tile coordinates/)
})

test("HTTP: tile endpoint serves MVT for tile queries only", { skip: !AVAILABLE }, async () => {
  const z = 12
  const { x, y } = tileAt(LON, LAT, z)
  const headers = { authorization: `Bearer ${bearer}` }

  const res = await fetch(`${base}/api/dashboards/tiledash/tiles/sites/${z}/${x}/${y}.mvt`, { headers })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-type"), "application/vnd.mapbox-vector-tile")
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.ok(bytes.length > 0 && bytes.includes("sites"))

  const params = encodeURIComponent(JSON.stringify({ kind: "well" }))
  const filtered = await fetch(
    `${base}/api/dashboards/tiledash/tiles/sites/${z}/${x}/${y}.mvt?params=${params}`,
    { headers }
  )
  assert.equal(filtered.status, 200)
  const filteredBytes = Buffer.from(await filtered.arrayBuffer())
  assert.ok(filteredBytes.includes("well") && !filteredBytes.includes("spring"), "bound param filters the tile")

  // A plain stored query is not a tile query; unknown names 404 the same way
  assert.equal(
    (await fetch(`${base}/api/dashboards/tiledash/tiles/counts/${z}/${x}/${y}.mvt`, { headers })).status,
    404
  )
  assert.equal(
    (await fetch(`${base}/api/dashboards/tiledash/tiles/nope/${z}/${x}/${y}.mvt`, { headers })).status,
    404
  )
  // No credentials, no tiles
  assert.equal((await fetch(`${base}/api/dashboards/tiledash/tiles/sites/${z}/${x}/${y}.mvt`)).status, 401)
})

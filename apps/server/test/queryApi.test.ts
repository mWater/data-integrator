import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { applyRows } from "../src/destinations.js"
import { createApiToken, createUser, getTokenUser, revokeApiToken, listApiTokens } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** Integration owning the queryable fixture table. */
const SOURCE: IntegrationDefinition = {
  id: "q_src",
  name: { _base: "en", en: "Query source" },
  trigger: {},
  runtime: "node",
  destinations: [
    {
      kind: "table",
      tableId: "q_sites",
      action: "replace",
      columns: [
        { id: "name", type: "text" },
        { id: "level", type: "number" },
        { id: "geom", type: "geometry" }
      ]
    }
  ],
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
  await installIntegration(pool, SOURCE)

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await applyRows(
      client,
      SOURCE.destinations[0] as never,
      [
        { name: "well_a", level: 4.2, geom: { type: "Point", coordinates: [47.1, -19.2] } },
        { name: "well_b", level: 7.9, geom: { type: "Point", coordinates: [45.5, -20.1] } },
        { name: "spring_c", level: 1.3, geom: null }
      ],
      randomUUID()
    )
    await client.query("COMMIT")
  } finally {
    client.release()
  }

  const user = await createUser(pool, "api@example.org", "hunter2hunter2", "viewer")
  bearer = await createApiToken(pool, user.id, "test-token")

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
})

/** GET with the bearer token. */
function get(pathAndQuery: string): Promise<Response> {
  return fetch(`${base}${pathAndQuery}`, { headers: { authorization: `Bearer ${bearer}` } })
}

test("bearer token authenticates; garbage and revoked tokens do not", async () => {
  assert.equal((await fetch(`${base}/api/tables`)).status, 401)
  assert.equal((await fetch(`${base}/api/tables`, { headers: { authorization: "Bearer dit_nope" } })).status, 401)
  assert.equal((await get("/api/tables")).status, 200)

  const resolved = await getTokenUser(pool, bearer)
  assert.equal(resolved?.email, "api@example.org")
  const listed = await listApiTokens(pool, resolved!.id)
  assert.equal(listed[0].name, "test-token")
  assert.ok(listed[0].lastUsedAt, "last_used_at stamped")

  const throwaway = await createApiToken(pool, resolved!.id, "gone")
  const throwawayId = (await listApiTokens(pool, resolved!.id)).find(t => t.name === "gone")!.id
  assert.ok(await revokeApiToken(pool, resolved!.id, throwawayId))
  assert.equal(await getTokenUser(pool, throwaway), null)
})

test("expired tokens stop working", async () => {
  const user = (await pool.query("SELECT id FROM app.users WHERE email = 'api@example.org'")).rows[0]
  const shortLived = await createApiToken(pool, user.id, "expiring", 1)
  assert.ok(await getTokenUser(pool, shortLived))
  await pool.query("UPDATE app.api_tokens SET expires_at = now() - interval '1 minute' WHERE name = 'expiring'")
  assert.equal(await getTokenUser(pool, shortLived), null)
})

test("tables list describes the declared schema", async () => {
  const body = await (await get("/api/tables")).json()
  const table = body.tables.find((t: { tableId: string }) => t.tableId === "q_sites")
  assert.equal(table.integrationId, "q_src")
  assert.deepEqual(table.columns.map((c: { id: string }) => c.id), ["name", "level", "geom"])
})

test("rows: filters, columns, order, limit, paging", async () => {
  const all = await (await get("/api/tables/q_sites/rows")).json()
  assert.equal(all.rows.length, 3)
  assert.deepEqual(all.columns, ["name", "level", "geom"])

  const where = encodeURIComponent(JSON.stringify([{ column: "level", op: ">", value: 2 }]))
  const filtered = await (await get(`/api/tables/q_sites/rows?where=${where}&order=level.desc&columns=name,level`)).json()
  assert.deepEqual(filtered.rows, [
    { name: "well_b", level: 7.9 },
    { name: "well_a", level: 4.2 }
  ])

  const paged = await (await get("/api/tables/q_sites/rows?order=name&limit=1&offset=1")).json()
  assert.equal(paged.rows[0].name, "well_a")

  assert.equal((await get("/api/tables/nope/rows")).status, 404)
  assert.equal((await get("/api/tables/q_sites/rows?order=evil")).status, 400)
  assert.equal((await get(`/api/tables/q_sites/rows?where=${encodeURIComponent('[{"column":"x;drop","op":"=","value":1}]')}`)).status, 400)
})

test("rows: csv and geojson formats", async () => {
  const csv = await (await get("/api/tables/q_sites/rows?format=csv&columns=name,level&order=name")).text()
  assert.equal(csv.split("\n")[0], "name,level")
  assert.match(csv, /spring_c,1\.3/)

  const geo = await (await get("/api/tables/q_sites/rows?format=geojson&order=name")).json()
  assert.equal(geo.type, "FeatureCollection")
  assert.equal(geo.features.length, 3)
  const wellA = geo.features.find((f: { properties: { name: string } }) => f.properties.name === "well_a")
  assert.deepEqual(wellA.geometry.coordinates, [47.1, -19.2])
  assert.equal(wellA.properties.level, 4.2)
})

test("settings: countries list, default AOI roundtrip, role enforcement", async () => {
  const countriesRes = await (await get("/api/countries")).json()
  const mdg = countriesRes.countries.find((c: { iso3: string }) => c.iso3 === "MDG")
  assert.ok(mdg, "Madagascar in the baked-in list")

  // Unset by default
  const initial = await (await get("/api/settings")).json()
  assert.equal(initial.settings.default_aoi, null)

  // The viewer token cannot write settings
  const aoi = { bbox: mdg.bbox, countries: ["MDG"], name: "Madagascar" }
  const forbidden = await fetch(`${base}/api/settings/default_aoi`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(aoi)
  })
  assert.equal(forbidden.status, 403)

  const admin = await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")
  const adminBearer = await createApiToken(pool, admin.id, "admin-token")
  const adminPut = (body: unknown) =>
    fetch(`${base}/api/settings/default_aoi`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    })

  assert.equal((await adminPut({ bbox: [1, 2, 3] })).status, 400)
  assert.equal((await adminPut(aoi)).status, 200)

  const stored = await (await get("/api/settings")).json()
  assert.deepEqual(stored.settings.default_aoi, aoi)

  const cleared = await fetch(`${base}/api/settings/default_aoi`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminBearer}` }
  })
  assert.equal(cleared.status, 200)
  assert.equal((await (await get("/api/settings")).json()).settings.default_aoi, null)
})

test("AOI edits are versioned definition changes with attribution", async () => {
  // Viewers cannot change AOI
  const forbidden = await fetch(`${base}/api/integrations/q_src/aoi`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: "full" })
  })
  assert.equal(forbidden.status, 403)

  const admin = await createUser(pool, "aoi-admin@example.org", "hunter2hunter2", "admin")
  const adminBearer = await createApiToken(pool, admin.id, "aoi-token")
  const put = (body: unknown) =>
    fetch(`${base}/api/integrations/q_src/aoi`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    })

  assert.equal((await put({ mode: "sideways" })).status, 400)
  assert.equal((await put({ mode: "box", aoi: { bbox: [1, 2, 3] } })).status, 400)

  // Explicit box -> v2; explicit full extent -> v3; back to inherit -> v4
  const boxed = await (await put({ mode: "box", aoi: { bbox: [43.2, -25.6, 50.5, -12.0], countries: ["MDG"] } })).json()
  assert.equal(boxed.version, 2)
  let detail = await (await get("/api/integrations/q_src")).json()
  assert.deepEqual(detail.definition.aoi, { bbox: [43.2, -25.6, 50.5, -12.0], countries: ["MDG"] })

  assert.equal((await (await put({ mode: "full" })).json()).version, 3)
  detail = await (await get("/api/integrations/q_src")).json()
  assert.equal(detail.definition.aoi, null)

  assert.equal((await (await put({ mode: "inherit" })).json()).version, 4)
  detail = await (await get("/api/integrations/q_src")).json()
  assert.equal("aoi" in detail.definition, false)

  // Repeating the same state is a no-op, not a new version
  assert.equal((await (await put({ mode: "inherit" })).json()).version, 4)

  const history = await (await get("/api/integrations/q_src/versions")).json()
  assert.deepEqual(
    history.versions.map((v: { version: number; createdBy: string | null; aoiMode: string }) => [
      v.version, v.createdBy, v.aoiMode
    ]),
    [
      [4, "aoi-admin@example.org", "inherit"],
      [3, "aoi-admin@example.org", "full"],
      [2, "aoi-admin@example.org", "box"],
      [1, null, "inherit"]
    ]
  )
  assert.deepEqual(history.versions[2].aoi.countries, ["MDG"])

  assert.equal((await get("/api/integrations/nope/versions")).status, 404)
})

test("schedule and enabled are editable without the agent", async () => {
  const admin = await createUser(pool, "sched-admin@example.org", "hunter2hunter2", "admin")
  const adminBearer = await createApiToken(pool, admin.id, "sched-token")
  const put = (pathname: string, body: unknown) =>
    fetch(`${base}${pathname}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    })

  // Viewers cannot change either
  const forbidden = await fetch(`${base}/api/integrations/q_src/trigger`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ cron: "0 6 * * *" })
  })
  assert.equal(forbidden.status, 403)

  // Bad cron rejected with the parser's message
  const bad = await put("/api/integrations/q_src/trigger", { cron: "not a cron" })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /Cron|cron/)

  // Valid schedule: a versioned definition edit
  const set = await (await put("/api/integrations/q_src/trigger", { cron: "0 6 * * *", webhook: true })).json()
  assert.deepEqual(set.trigger, { cron: "0 6 * * *", webhook: true })
  let detail = await (await get("/api/integrations/q_src")).json()
  assert.equal(detail.version, set.version)
  assert.deepEqual(detail.definition.trigger, { cron: "0 6 * * *", webhook: true })

  // Same schedule again is a no-op, not a new version
  const again = await (await put("/api/integrations/q_src/trigger", { cron: "0 6 * * *", webhook: true })).json()
  assert.equal(again.version, set.version)

  // Back to manual-only
  const manual = await (await put("/api/integrations/q_src/trigger", { cron: null })).json()
  assert.deepEqual(manual.trigger, {})

  // Enabled: a plain column flip, no version change
  const versionBefore = (await (await get("/api/integrations/q_src")).json()).version
  assert.deepEqual(await (await put("/api/integrations/q_src/enabled", { enabled: false })).json(), { enabled: false })
  detail = await (await get("/api/integrations/q_src")).json()
  assert.equal(detail.enabled, false)
  assert.equal(detail.version, versionBefore)
  assert.equal((await put("/api/integrations/q_src/enabled", { enabled: "nope" })).status, 400)
  assert.equal((await put("/api/integrations/nope/enabled", { enabled: true })).status, 404)
})

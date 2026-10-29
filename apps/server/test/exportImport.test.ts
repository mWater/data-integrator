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
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** An installed integration with an explicit AOI, to prove export strips it. */
const SHARED: IntegrationDefinition = {
  id: "shared_demo",
  name: { _base: "en", en: "Shared demo" },
  source: { name: { _base: "en", en: "Demo source" }, provider: "Demo Org", license: "CC-BY-4.0" },
  trigger: { cron: "0 6 1 * *" },
  aoi: { bbox: [43, -26, 51, -11] },
  runtime: "node",
  destinations: [{ kind: "table", tableId: "shared_rows", action: "replace", columns: [{ id: "name", type: "text" }] }],
  code: "export default async function run() { return {} }",
  contract: 2
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let viewerBearer: string
let editorBearer: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)

  const viewer = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  viewerBearer = await createApiToken(pool, viewer.id, "viewer-token")
  const editor = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editorBearer = await createApiToken(pool, editor.id, "editor-token")

  await installIntegration(pool, SHARED)
  await installIntegration(pool, {
    ...SHARED,
    id: "global_demo",
    aoi: null,
    destinations: [{ ...SHARED.destinations[0], tableId: "global_rows" } as IntegrationDefinition["destinations"][number]]
  })

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

test("export is a downloadable definition with a concrete AOI stripped", async () => {
  const res = await call("/api/integrations/shared_demo/export", viewerBearer)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-disposition") ?? "", /shared_demo\.integration\.json/)
  const exported = await res.json()
  assert.equal(exported.id, "shared_demo")
  assert.equal(exported.code, SHARED.code)
  assert.equal("aoi" in exported, false)

  // Full extent is a property of the source, so it travels
  const global = await (await call("/api/integrations/global_demo/export", viewerBearer)).json()
  assert.equal(global.aoi, null)

  assert.equal((await call("/api/integrations/nope/export", viewerBearer)).status, 404)
})

test("import round-trips an export, landing paused with a version history", async () => {
  const exported = await (await call("/api/integrations/shared_demo/export", editorBearer)).json()
  const copy = { ...exported, id: "shared_copy" }
  // Same table would collide with the original's ownership
  copy.destinations = [{ ...copy.destinations[0], tableId: "shared_copy_rows" }]

  const res = await call("/api/integrations/import", editorBearer, { method: "POST", body: JSON.stringify(copy) })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: "shared_copy", version: 1, enabled: false })

  const row = await pool.query("SELECT enabled, status, version FROM app.integrations WHERE id = 'shared_copy'")
  assert.deepEqual(row.rows[0], { enabled: false, status: "ready", version: 1 })
})

test("import rejects viewers, duplicates, non-definitions, and destination collisions", async () => {
  const exported = await (await call("/api/integrations/shared_demo/export", editorBearer)).json()

  const viewer = await call("/api/integrations/import", viewerBearer, { method: "POST", body: JSON.stringify(exported) })
  assert.equal(viewer.status, 403)

  // Same id is already installed
  const dup = await call("/api/integrations/import", editorBearer, { method: "POST", body: JSON.stringify(exported) })
  assert.equal(dup.status, 409)

  const junk = await call("/api/integrations/import", editorBearer, { method: "POST", body: JSON.stringify({ hello: 1 }) })
  assert.equal(junk.status, 400)

  // New id but a destination table another integration owns
  const clash = { ...exported, id: "shared_clash" }
  const res = await call("/api/integrations/import", editorBearer, { method: "POST", body: JSON.stringify(clash) })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /owned by/)
})

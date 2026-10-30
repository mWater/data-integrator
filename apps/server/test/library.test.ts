import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import pg from "pg"
import { fileURLToPath } from "node:url"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** The library entry the tests install and update. */
const DEFINITION = {
  id: "lib_demo",
  name: { _base: "en", en: "Library demo" },
  description: { _base: "en", en: "A demo entry" },
  source: { name: { _base: "en", en: "Demo source" }, provider: "Demo Org", license: "CC-BY-4.0" },
  trigger: { cron: "0 6 1 * *" },
  runtime: "node",
  destinations: [
    { kind: "table", tableId: "lib_rows", action: "replace", columns: [{ id: "name", type: "text" }] }
  ],
  code: "",
  contract: 2
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let libraryPath: string
let viewerBearer: string
let editorBearer: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)

  libraryPath = await mkdtemp(path.join(tmpdir(), "library-test-"))
  await mkdir(path.join(libraryPath, "integrations", "lib_demo"), { recursive: true })
  await writeFile(path.join(libraryPath, "integrations", "lib_demo", "definition.json"), JSON.stringify(DEFINITION))
  await writeFile(
    path.join(libraryPath, "integrations", "lib_demo", "code.mjs"),
    "export default async function run() { return {} }\n"
  )

  const viewer = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  viewerBearer = await createApiToken(pool, viewer.id, "viewer-token")
  const editor = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editorBearer = await createApiToken(pool, editor.id, "editor-token")

  server = createApiServer(
    pool,
    new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"),
    null, null, null, null, null, null,
    libraryPath
  )
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
  await rm(libraryPath, { recursive: true, force: true })
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

test("library: browse, role-gated install, update detection with carry-over", async () => {
  // Browse: entry visible, not installed
  const initial = await (await call("/api/library", viewerBearer)).json()
  assert.equal(initial.entries.length, 1)
  assert.equal(initial.entries[0].id, "lib_demo")
  assert.equal(initial.entries[0].status, "not_installed")
  assert.equal(initial.entries[0].destinations[0].id, "lib_rows")

  // Viewers cannot install
  const forbidden = await call("/api/library/lib_demo/install", viewerBearer, { method: "POST", body: "{}" })
  assert.equal(forbidden.status, 403)

  // Editor installs; no runner on this server, so runNow yields no run
  const installedRes = await call("/api/library/lib_demo/install", editorBearer, {
    method: "POST",
    body: JSON.stringify({ runNow: true })
  })
  assert.equal(installedRes.status, 200)
  assert.deepEqual(await installedRes.json(), { version: 1, runId: null })

  const afterInstall = await (await call("/api/library", viewerBearer)).json()
  assert.equal(afterInstall.entries[0].status, "installed")
  assert.equal(afterInstall.entries[0].installedVersion, 1)

  // A local AOI change (full extent -> v2) must not read as a library update
  const aoiRes = await call("/api/integrations/lib_demo/aoi", editorBearer, {
    method: "PUT",
    body: JSON.stringify({ mode: "full" })
  })
  assert.equal((await aoiRes.json()).version, 2)
  const afterAoi = await (await call("/api/library", viewerBearer)).json()
  assert.equal(afterAoi.entries[0].status, "installed")

  // Library moves: update detected; updating carries the local AOI over
  await writeFile(
    path.join(libraryPath, "integrations", "lib_demo", "definition.json"),
    JSON.stringify({ ...DEFINITION, description: { _base: "en", en: "A better demo entry" } })
  )
  const afterEdit = await (await call("/api/library", viewerBearer)).json()
  assert.equal(afterEdit.entries[0].status, "update_available")

  const updated = await (await call("/api/library/lib_demo/install", editorBearer, { method: "POST", body: "{}" })).json()
  assert.equal(updated.version, 3)
  const detail = await (await call("/api/integrations/lib_demo", viewerBearer)).json()
  assert.deepEqual(detail.definition.description, { _base: "en", en: "A better demo entry" })
  assert.equal(detail.definition.aoi, null, "local full-extent AOI carried over")

  const versions = await (await call("/api/integrations/lib_demo/versions", viewerBearer)).json()
  assert.equal(versions.versions[0].version, 3)
  assert.equal(versions.versions[0].createdBy, "editor@example.org")

  // Unknown entries 404
  assert.equal((await call("/api/library/nope/install", editorBearer, { method: "POST", body: "{}" })).status, 404)
})

test("settings: editors set values as versioned edits; library updates keep the ones still valid", async () => {
  const label = { _base: "en", en: "Months" }
  const withSettings = (max: number) => ({
    ...DEFINITION,
    id: "lib_settings",
    destinations: [{ kind: "table", tableId: "lib_settings_rows", action: "replace", columns: [{ id: "n", type: "integer" }] }],
    settings: {
      months_back: { label, type: "integer", default: 12, min: 1, max },
      simplified: { label, type: "boolean", default: false }
    }
  })
  const entryDir = path.join(libraryPath, "integrations", "lib_settings")
  await mkdir(entryDir, { recursive: true })
  await writeFile(path.join(entryDir, "definition.json"), JSON.stringify(withSettings(120)))
  await writeFile(path.join(entryDir, "code.mjs"), "export default async function run() { return {} }\n")
  assert.equal((await call("/api/library/lib_settings/install", editorBearer, { method: "POST", body: "{}" })).status, 200)

  const put = (bearer: string, values: unknown) =>
    call("/api/integrations/lib_settings/settings", bearer, { method: "PUT", body: JSON.stringify({ values }) })
  assert.equal((await put(viewerBearer, { months_back: 24 })).status, 403)
  const invalid = await put(editorBearer, { months_back: 500 })
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).error, /settingValues\.months_back must be at most 120/)
  assert.equal((await put(editorBearer, { undeclared: 1 })).status, 400)

  assert.equal((await (await put(editorBearer, { months_back: 60, simplified: true })).json()).version, 2)
  assert.equal((await (await put(editorBearer, { simplified: null })).json()).version, 3)
  let detail = await (await call("/api/integrations/lib_settings", viewerBearer)).json()
  assert.deepEqual(detail.definition.settingValues, { months_back: 60 })

  // Setting values are the deployment's: they never read as a library update
  const listed = await (await call("/api/library", viewerBearer)).json()
  assert.equal(listed.entries.find((e: { id: string }) => e.id === "lib_settings").status, "installed")

  // The entry narrows the setting: the deployment's 60 no longer fits and falls back to the default
  await writeFile(path.join(entryDir, "definition.json"), JSON.stringify(withSettings(36)))
  assert.equal((await call("/api/library/lib_settings/install", editorBearer, { method: "POST", body: "{}" })).status, 200)
  detail = await (await call("/api/integrations/lib_settings", viewerBearer)).json()
  assert.equal(detail.definition.settingValues, undefined)
})

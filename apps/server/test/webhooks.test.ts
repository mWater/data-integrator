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

/** A webhook-triggered integration and a cron-only one that must not accept events. */
const HOOKED: IntegrationDefinition = {
  id: "hooked",
  name: { _base: "en", en: "Webhook demo" },
  trigger: { webhook: true },
  runtime: "node",
  destinations: [{ kind: "table", tableId: "hooked_rows", action: "replace", columns: [{ id: "name", type: "text" }] }],
  code: "export default async function run() { return {} }",
  contract: 2
}
const DELAYED: IntegrationDefinition = {
  ...HOOKED,
  id: "delayed",
  trigger: { webhook: true, webhookDelaySeconds: 600 },
  destinations: [{ kind: "table", tableId: "delayed_rows", action: "replace", columns: [{ id: "name", type: "text" }] }]
}
const CRON_ONLY: IntegrationDefinition = {
  ...HOOKED,
  id: "cron_only",
  trigger: { cron: "0 6 1 * *" },
  destinations: [{ kind: "table", tableId: "cron_rows", action: "replace", columns: [{ id: "name", type: "text" }] }]
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let viewerBearer: string
let editorBearer: string
let adminBearer: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)

  const viewer = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  viewerBearer = await createApiToken(pool, viewer.id, "viewer-token")
  const editor = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editorBearer = await createApiToken(pool, editor.id, "editor-token")
  const admin = await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")
  adminBearer = await createApiToken(pool, admin.id, "admin-token")

  await installIntegration(pool, HOOKED)
  await installIntegration(pool, DELAYED)
  await installIntegration(pool, CRON_ONLY)

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

function post(token: string, body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${base}/hooks/${token}`, { method: "POST", headers: { "content-type": contentType }, body })
}

async function token(id: string): Promise<string> {
  const res = await call(`/api/integrations/${id}/webhook-token`, editorBearer)
  assert.equal(res.status, 200)
  return (await res.json()).token
}

test("webhook receipt stores the event and enqueues one coalesced run", async () => {
  const hookToken = await token("hooked")

  const first = await post(hookToken, JSON.stringify({ n: 1 }))
  assert.equal(first.status, 202)
  const { eventId } = await first.json()
  assert.ok(eventId)

  // A second receipt while a run is queued buffers into the same batch
  const second = await post(hookToken, JSON.stringify({ n: 2 }))
  assert.equal(second.status, 202)

  const events = await pool.query(
    "SELECT payload FROM app.webhook_events WHERE integration_id = 'hooked' AND run_id IS NULL ORDER BY received_at"
  )
  assert.deepEqual(events.rows.map(r => r.payload), [{ n: 1 }, { n: 2 }])

  const runs = await pool.query("SELECT trigger, status FROM app.runs WHERE integration_id = 'hooked'")
  assert.equal(runs.rows.length, 1)
  assert.deepEqual(runs.rows[0], { trigger: "webhook", status: "queued" })
})

test("webhookDelaySeconds opens a batch window the first event anchors", async () => {
  const first = await post(await token("delayed"), JSON.stringify({ n: 1 }))
  assert.equal(first.status, 202)

  // The run sits at the end of the window, out of claimNextRun's reach
  const queued = await pool.query(
    `SELECT scheduled_at > now() + interval '9 minutes' AS windowed
     FROM app.runs WHERE integration_id = 'delayed' AND status = 'queued'`
  )
  assert.equal(queued.rows.length, 1)
  assert.equal(queued.rows[0].windowed, true)

  // A later event joins the batch without moving the window
  const stamp = await pool.query("SELECT scheduled_at FROM app.runs WHERE integration_id = 'delayed'")
  await post(await token("delayed"), JSON.stringify({ n: 2 }))
  const after = await pool.query("SELECT scheduled_at FROM app.runs WHERE integration_id = 'delayed'")
  assert.equal(after.rows.length, 1)
  assert.deepEqual(after.rows[0].scheduled_at, stamp.rows[0].scheduled_at)
})

test("receipts for paused integrations buffer without enqueueing", async () => {
  await pool.query("DELETE FROM app.runs WHERE integration_id = 'hooked'")
  await pool.query("DELETE FROM app.webhook_events WHERE integration_id = 'hooked'")
  await pool.query("UPDATE app.integrations SET enabled = false WHERE id = 'hooked'")
  try {
    const res = await post(await token("hooked"), JSON.stringify({ paused: true }))
    assert.equal(res.status, 202)
    const events = await pool.query("SELECT count(*) AS n FROM app.webhook_events WHERE integration_id = 'hooked'")
    assert.equal(Number(events.rows[0].n), 1)
    const runs = await pool.query("SELECT count(*) AS n FROM app.runs WHERE integration_id = 'hooked'")
    assert.equal(Number(runs.rows[0].n), 0)
  } finally {
    await pool.query("UPDATE app.integrations SET enabled = true WHERE id = 'hooked'")
  }
})

test("receiver rejects bad tokens, non-webhook integrations, and bad payloads", async () => {
  // Unknown token and a real token of a cron-only integration 404 alike
  assert.equal((await post("11111111-2222-3333-4444-555555555555", "{}")).status, 404)
  assert.equal((await post(await token("cron_only"), "{}")).status, 404)
  // Malformed token segment never reaches the database
  assert.equal((await post("not-a-uuid", "{}")).status, 404)
  // JSON only
  assert.equal((await post(await token("hooked"), "a,b,c", "text/csv")).status, 415)
  assert.equal((await post(await token("hooked"), "{not json")).status, 400)
  // The receiver is POST-only
  const got = await fetch(`${base}/hooks/11111111-2222-3333-4444-555555555555`)
  assert.equal(got.status, 405)
})

test("token endpoint gates by role; rotation invalidates the old URL", async () => {
  // Viewers see nothing; editors read but cannot rotate
  assert.equal((await call("/api/integrations/hooked/webhook-token", viewerBearer)).status, 403)
  assert.equal((await call("/api/integrations/hooked/webhook-token", editorBearer, { method: "POST" })).status, 403)
  assert.equal((await call("/api/integrations/nope/webhook-token", editorBearer)).status, 404)

  const before = await token("hooked")
  const rotated = await call("/api/integrations/hooked/webhook-token", adminBearer, { method: "POST" })
  assert.equal(rotated.status, 200)
  const { token: after, path: hookPath } = await rotated.json()
  assert.notEqual(after, before)
  assert.equal(hookPath, `/hooks/${after}`)

  assert.equal((await post(before, "{}")).status, 404)
  assert.equal((await post(after, "{}")).status, 202)
})

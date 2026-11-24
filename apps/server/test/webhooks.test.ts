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

/** Posts to the header form of the receiver: the integration id in the URL, the token in a header. */
function postTo(id: string, headers: Record<string, string>, body = "{}", contentType = "application/json"): Promise<Response> {
  return fetch(`${base}/hooks/${id}`, { method: "POST", headers: { "content-type": contentType, ...headers }, body })
}

/** Number of webhook events stored for an integration. */
async function eventCount(id: string): Promise<number> {
  return (await pool.query("SELECT count(*)::int AS n FROM app.webhook_events WHERE integration_id = $1", [id])).rows[0].n
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
  const { token: after, path: hookPath, headerPath } = await rotated.json()
  assert.notEqual(after, before)
  assert.equal(hookPath, `/hooks/${after}`)
  assert.equal(headerPath, "/hooks/hooked")

  assert.equal((await post(before, "{}")).status, 404)
  assert.equal((await post(after, "{}")).status, 202)
  // The header form uses the same token, so rotation invalidates it there too
  assert.equal((await postTo("hooked", { authorization: `Bearer ${before}` })).status, 401)
  assert.equal((await postTo("hooked", { authorization: `Bearer ${after}` })).status, 202)
})

test("the token is accepted in a header at /hooks/<integration id>", async () => {
  const hookToken = await token("hooked")
  const before = await eventCount("hooked")

  const bearer = await postTo("hooked", { authorization: `Bearer ${hookToken}` }, JSON.stringify({ via: "bearer" }))
  assert.equal(bearer.status, 202)
  assert.ok((await bearer.json()).eventId)
  // The scheme name is case-insensitive, and so is the token's hex
  assert.equal((await postTo("hooked", { authorization: `bearer ${hookToken.toUpperCase()}` }, JSON.stringify({ via: "lower" }))).status, 202)
  // For senders whose Authorization header is not theirs to set
  assert.equal((await postTo("hooked", { "x-webhook-token": hookToken }, JSON.stringify({ via: "custom" }))).status, 202)
  // A usable custom header is not shadowed by an Authorization header meant for something else
  assert.equal(
    (await postTo("hooked", { authorization: "Basic dXNlcjpwYXNz", "x-webhook-token": hookToken }, JSON.stringify({ via: "both" }))).status,
    202
  )

  assert.equal(await eventCount("hooked"), before + 4)
  const stored = await pool.query(
    "SELECT payload FROM app.webhook_events WHERE integration_id = 'hooked' ORDER BY received_at DESC LIMIT 4"
  )
  assert.deepEqual(stored.rows.map(r => r.payload.via).sort(), ["bearer", "both", "custom", "lower"])
})

test("the header form answers 401 to anything but that integration's own token", async () => {
  const hookToken = await token("hooked")
  const otherToken = await token("delayed")
  const cronToken = await token("cron_only")
  const before = { hooked: await eventCount("hooked"), delayed: await eventCount("delayed"), cron: await eventCount("cron_only") }

  const missing = await postTo("hooked", {})
  assert.equal(missing.status, 401)
  assert.equal(missing.headers.get("www-authenticate"), "Bearer")
  assert.deepEqual(await missing.json(), { error: "unauthorized" })

  // Not a token; another integration's token; a well-formed token nobody has
  assert.equal((await postTo("hooked", { authorization: "Bearer not-a-token" })).status, 401)
  assert.equal((await postTo("hooked", { authorization: `Bearer ${otherToken}` })).status, 401)
  assert.equal((await postTo("hooked", { authorization: "Bearer 11111111-2222-3333-4444-555555555555" })).status, 401)
  // A personal access token is a different credential
  assert.equal((await postTo("hooked", { authorization: `Bearer ${editorBearer}` })).status, 401)
  // An unknown id, and an integration that does not accept webhooks, look the same
  assert.equal((await postTo("no_such_integration", { authorization: `Bearer ${hookToken}` })).status, 401)
  assert.equal((await postTo("cron_only", { authorization: `Bearer ${cronToken}` })).status, 401)

  assert.deepEqual(
    { hooked: await eventCount("hooked"), delayed: await eventCount("delayed"), cron: await eventCount("cron_only") },
    before
  )

  // With a valid token the payload rules are those of the URL form
  assert.equal((await postTo("hooked", { authorization: `Bearer ${hookToken}` }, "a,b,c", "text/csv")).status, 415)
  assert.equal((await postTo("hooked", { authorization: `Bearer ${hookToken}` }, "{not json")).status, 400)
  // A path that is neither a token nor an integration id is not a webhook at all
  assert.equal((await postTo("Not-An-Id", { authorization: `Bearer ${hookToken}` })).status, 404)
  assert.equal((await fetch(`${base}/hooks/hooked`)).status, 405)
})

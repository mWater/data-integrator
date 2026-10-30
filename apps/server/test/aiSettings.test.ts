import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { createServer, Server } from "node:http"
import path from "node:path"
import pg from "pg"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { generateText } from "ai"
import { migrate } from "../src/migrations.js"
import { acknowledgeAi, createApiToken, createUser, getAiAcknowledged } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { AgentService } from "../src/agent/service.js"
import { AI_KEY, AiConfig, AiRuntime, loadAiConfig, parseAiConfig, saveAiConfig } from "../src/aiSettings.js"
import { getSetting } from "../src/settings.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let endpoint: Server
let endpointUrl: string
/** Authorization headers the fake endpoint received, newest last */
const seenAuth: (string | undefined)[] = []
let adminBearer: string
let adminId: string
let editorBearer: string
let editorId: string
let ai: AiRuntime
const key = randomBytes(32)

/** One chat completion in the OpenAI wire format. */
function completion(text: string) {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 0,
    model: "local-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  process.env.INTEGRATOR_SECRET_KEY = key.toString("hex")

  // An OpenAI-compatible endpoint that answers every chat request with OK;
  // /broken/ paths fail like a wrong model name
  endpoint = createServer((req, res) => {
    seenAuth.push(req.headers.authorization)
    req.resume()
    req.on("end", () => {
      if (req.url?.startsWith("/broken/")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "model not found" } }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(completion("OK")))
    })
  })
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve))
  endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`

  const admin = await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")
  adminId = admin.id
  adminBearer = await createApiToken(pool, admin.id, "admin-token")
  const editor = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editorId = editor.id
  editorBearer = await createApiToken(pool, editor.id, "editor-token")

  ai = new AiRuntime(null)
  const assistant = AgentService.forAssistant(pool, { pool, model: ai.model })
  server = createApiServer(
    pool,
    new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"),
    null, null, null, null, null, null, null,
    assistant,
    ai
  )
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  delete process.env.INTEGRATOR_SECRET_KEY
  server?.close()
  endpoint?.close()
  await pool?.end()
  await db?.stop()
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

test("parseAiConfig: a blank key keeps the saved one only for the same provider and endpoint", () => {
  const saved: AiConfig = { provider: "custom", model: "m", baseUrl: "https://llm.example.org/v1", apiKey: "k1" }
  const same = parseAiConfig({ provider: "custom", model: "m2", baseUrl: "https://llm.example.org/v1/", apiKey: "" }, saved)
  assert.equal(same.apiKey, "k1")
  assert.equal(same.baseUrl, "https://llm.example.org/v1")
  // A new endpoint never receives the key entered for the old one
  const moved = parseAiConfig({ provider: "custom", model: "m", baseUrl: "https://other.example.org/v1" }, saved)
  assert.equal(moved.apiKey, null)
  assert.throws(() => parseAiConfig({ provider: "openrouter" }, saved), /API key/)
  assert.throws(() => parseAiConfig({ provider: "custom", model: "m" }, null), /base URL/)
  assert.throws(() => parseAiConfig({ provider: "custom", baseUrl: "https://x.example.org" }, null), /model/)
  assert.throws(() => parseAiConfig({ provider: "custom", model: "m", baseUrl: "file:///etc/passwd" }, null), /http/)
  assert.throws(() => parseAiConfig({ provider: "custom", model: "m", baseUrl: "https://u:p@x.example.org" }, null), /key field/)
  assert.throws(() => parseAiConfig({ provider: "gemini", apiKey: "k" }, null), /provider/)
})

test("saveAiConfig: the key is stored encrypted and reads back", async () => {
  const config: AiConfig = { provider: "openrouter", model: null, baseUrl: null, apiKey: "sk-or-plain-value" }
  await saveAiConfig(pool, key, config)
  const raw = JSON.stringify(await getSetting(pool, AI_KEY))
  assert.ok(!raw.includes("sk-or-plain-value"))
  assert.deepEqual(await loadAiConfig(pool, key), config)
  await assert.rejects(saveAiConfig(pool, null, config), /INTEGRATOR_SECRET_KEY/)
  await saveAiConfig(pool, key, null)
})

test("AiRuntime.load seeds Settings from the environment once", async () => {
  const logs: string[] = []
  const env = { OPENROUTER_API_KEY: "sk-or-from-env", AGENT_MODEL: "anthropic/claude-opus-5.5" }
  const first = await AiRuntime.load(pool, key, null, env, m => logs.push(m))
  assert.equal(first.provider, "openrouter")
  assert.equal(first.modelId, "anthropic/claude-opus-5.5")
  assert.equal((await loadAiConfig(pool, key))?.apiKey, "sk-or-from-env")
  // Settings win from then on; the environment is reported as ignored
  await saveAiConfig(pool, key, { provider: "anthropic", model: null, baseUrl: null, apiKey: "sk-ant" })
  const second = await AiRuntime.load(pool, key, null, env, m => logs.push(m))
  assert.equal(second.provider, "anthropic")
  assert.ok(logs.some(m => m.includes("ignored")))
  await saveAiConfig(pool, null, null)
})

test("http: only admins read or change the AI provider", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await call("/api/settings/ai", editorBearer, {
      method,
      ...(method === "PUT" ? { body: JSON.stringify({ provider: "custom", model: "m", baseUrl: endpointUrl }) } : {})
    })
    assert.equal(res.status, 403, method)
  }
  assert.equal(ai.configured(), false)
})

test("http: saving tests the endpoint, applies at once, and never returns the key", async () => {
  // Off: sessions are refused
  const off = await call("/api/sessions", editorBearer, { method: "POST", body: JSON.stringify({ kind: "assistant" }) })
  assert.equal(off.status, 503)

  const broken = await call("/api/settings/ai", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ provider: "custom", model: "local-model", baseUrl: `${endpointUrl.replace("/v1", "/broken/v1")}` })
  })
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).code, "ai_test_failed")
  assert.equal(await getSetting(pool, AI_KEY), null)

  const saved = await call("/api/settings/ai", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ provider: "custom", model: "local-model", baseUrl: endpointUrl, apiKey: "local-secret" })
  })
  assert.equal(saved.status, 200)
  const view = await saved.json()
  assert.equal(view.keySaved, true)
  assert.ok(!JSON.stringify(view).includes("local-secret"))
  assert.equal(seenAuth.at(-1), "Bearer local-secret")

  const read = await (await call("/api/settings/ai", adminBearer)).json()
  assert.ok(!JSON.stringify(read).includes("local-secret"))
  const me = await (await call("/api/me", editorBearer)).json()
  assert.deepEqual(me.ai, { provider: "custom", model: "local-model", ackRequired: false })

  // Agents built before the change call the new model through the handle
  const reply = await generateText({ model: ai.model, prompt: "hi" })
  assert.equal(reply.text, "OK")
  const on = await call("/api/sessions", editorBearer, { method: "POST", body: JSON.stringify({ kind: "assistant" }) })
  assert.equal(on.status, 201)

  const cleared = await call("/api/settings/ai", adminBearer, { method: "DELETE" })
  assert.equal(cleared.status, 200)
  assert.equal(ai.configured(), false)
  assert.equal(await getSetting(pool, AI_KEY), null)
})

test("http: switching provider asks everyone to accept the data notice again", async () => {
  await acknowledgeAi(pool, adminId)
  await acknowledgeAi(pool, editorId)
  const saved = await call("/api/settings/ai", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ provider: "custom", model: "local-model", baseUrl: endpointUrl })
  })
  assert.equal(saved.status, 200)
  assert.equal(await getAiAcknowledged(pool, adminId), false)
  assert.equal(await getAiAcknowledged(pool, editorId), false)
  // Same provider again: acceptances stand
  await acknowledgeAi(pool, editorId)
  await call("/api/settings/ai", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ provider: "custom", model: "other-model", baseUrl: endpointUrl })
  })
  assert.equal(await getAiAcknowledged(pool, editorId), true)
  await call("/api/settings/ai", adminBearer, { method: "DELETE" })
})

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import pg from "pg"
import { z } from "zod"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { applyRows } from "../src/destinations.js"
import { createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { AgentSessionController } from "../src/agent/controller.js"
import { AssistantImplementation, AssistantState, initialAssistantState } from "../src/agent/assistant.js"
import { AgentService } from "../src/agent/service.js"
import { AgentImplementation, ToolOutcome } from "../src/agent/types.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** Integration owning the queryable fixture table and a raster layer. */
const SOURCE: IntegrationDefinition = {
  id: "asst_src",
  name: { _base: "en", en: "Assistant source" },
  trigger: {},
  runtime: "node",
  destinations: [
    {
      kind: "table",
      tableId: "asst_sites",
      action: "replace",
      columns: [
        { id: "name", type: "text" },
        { id: "level", type: "number", units: "m" },
        { id: "geom", type: "geometry" }
      ]
    },
    {
      kind: "raster",
      layerId: "asst_rain",
      temporality: "time-series",
      bands: [{ id: "rain", units: "mm" }]
    }
  ],
  code: "export default async function run() { return {} }",
  contract: 2
}

/** V4 usage object for mock generate results. */
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
}

let db: TestDb
let pool: pg.Pool

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
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

/** Implementation over a mock model that never generates (tool units only). */
function impl(): AssistantImplementation {
  return new AssistantImplementation({ pool, model: new MockLanguageModelV4({}) })
}

/** Runs the query tool and asserts it succeeded, returning the new state. */
async function runQuery(a: AssistantImplementation, state: AssistantState, sql: string) {
  const outcome = await a.execute("query", { sql }, state, () => {}, "s1")
  assert.ok(!outcome.result.startsWith("Error:"), outcome.result)
  assert.ok(outcome.state, "query success carries state")
  return outcome as Required<Pick<ToolOutcome<AssistantState>, "state">> & ToolOutcome<AssistantState>
}

test("query: guards reject non-SELECT and stacked statements", async () => {
  const a = impl()
  const state = initialAssistantState()
  for (const sql of ["DELETE FROM asst_sites", "SELECT 1; SELECT 2", "EXPLAIN SELECT 1"]) {
    const outcome = await a.execute("query", { sql }, state, () => {}, "s1")
    assert.match(outcome.result, /^Error:/)
    assert.equal(outcome.state, undefined)
  }
})

test("query: success stores the complete result and previews it", async () => {
  const a = impl()
  const outcome = await runQuery(a, initialAssistantState(), "SELECT name, level FROM asst_sites ORDER BY name")
  const lines = outcome.result.split("\n")
  assert.equal(lines[0], "result_id: q1")
  assert.equal(lines[1], "rows: 3")
  assert.equal(lines[2], "columns: name, level")
  assert.match(outcome.result, /all 3 rows/)
  const stored = outcome.state.results.q1
  assert.equal(stored.rows.length, 3)
  assert.deepEqual(stored.columns, ["name", "level"])
  assert.equal(stored.rows[1].name, "well_a")
  assert.equal(outcome.state.nextResult, 2)
})

test("query: over-cap results are rejected, not truncated", async () => {
  const a = impl()
  const outcome = await a.execute("query", { sql: "SELECT generate_series(1, 2000) AS n" }, initialAssistantState(), () => {}, "s1")
  assert.match(outcome.result, /^Error: query failed: .*exceeds 1000 rows/)
  assert.equal(outcome.state, undefined)
})

test("query: results accumulate under fresh ids", async () => {
  const a = impl()
  const first = await runQuery(a, initialAssistantState(), "SELECT 1::int AS one")
  const second = await runQuery(a, first.state, "SELECT 2::int AS two")
  assert.deepEqual(Object.keys(second.state.results).sort(), ["q1", "q2"])
  assert.equal(second.state.nextResult, 3)
  assert.match(second.result, /^result_id: q2/)
})

test("query results stay private; show_table is what the user sees", async () => {
  const a = impl()
  const sql = "SELECT name, level FROM asst_sites ORDER BY name"
  const investigated = await runQuery(a, initialAssistantState(), sql)
  assert.match(investigated.result, /The user does not see this result/)

  const shown = await a.execute("show_table", { sql, title: "Sites" }, investigated.state, () => {}, "s1")
  assert.ok(!shown.result.startsWith("Error:"), shown.result)
  // Its own run, so it stores its own result rather than reusing the query's
  assert.match(shown.result, /^result_id: q2/)
  assert.match(shown.result, /shown to the user as a table/)
  assert.equal(shown.state?.results.q2.rows.length, 3)
})

test("show_table: applies the same statement guards as query", async () => {
  const a = impl()
  const state = initialAssistantState()
  for (const sql of ["DELETE FROM asst_sites", "SELECT 1; SELECT 2"]) {
    const outcome = await a.execute("show_table", { sql, title: "Bad" }, state, () => {}, "s1")
    assert.match(outcome.result, /^Error:/)
    assert.equal(outcome.state, undefined)
  }
})

test("show_chart: validates result, columns, and pie arity", async () => {
  const a = impl()
  const { state } = await runQuery(a, initialAssistantState(), "SELECT name, level FROM asst_sites ORDER BY name")
  const chart = { resultId: "q1", title: "Levels", type: "bar", x: "name", series: ["level"] }

  const unknown = await a.execute("show_chart", { ...chart, resultId: "q9" }, state, () => {}, "s1")
  assert.match(unknown.result, /^Error: unknown result/)

  const badCol = await a.execute("show_chart", { ...chart, series: ["depth"] }, state, () => {}, "s1")
  assert.match(badCol.result, /^Error: column\(s\) depth/)

  const badPie = await a.execute("show_chart", { ...chart, type: "pie", series: ["level", "name"] }, state, () => {}, "s1")
  assert.match(badPie.result, /^Error: pie takes exactly one/)

  const ok = await a.execute("show_chart", chart, state, () => {}, "s1")
  assert.equal(ok.result, 'Chart "Levels" is shown to the user, bound to q1.')
})

test("show_chart: warns on string-valued series columns", async () => {
  const a = impl()
  const { state } = await runQuery(a, initialAssistantState(), "SELECT name, count(*) AS n FROM asst_sites GROUP BY name")
  const outcome = await a.execute(
    "show_chart",
    { resultId: "q1", title: "Counts", type: "bar", x: "name", series: ["n"] },
    state,
    () => {},
    "s1"
  )
  assert.match(outcome.result, /is shown to the user/)
  assert.match(outcome.result, /note: column "n" has non-numeric values/)
})

test("show_map: validates layers, geometry declarations, and dates", async () => {
  const a = impl()
  const { state } = await runQuery(
    a,
    initialAssistantState(),
    "SELECT name, ST_AsGeoJSON(geom) AS gj, ST_X(geom)::float8 AS lon, ST_Y(geom)::float8 AS lat FROM asst_sites WHERE geom IS NOT NULL"
  )

  const empty = await a.execute("show_map", {}, state, () => {}, "s1")
  assert.match(empty.result, /^Error: give at least one/)

  const badLayer = await a.execute("show_map", { layers: [{ layerId: "nope" }] }, state, () => {}, "s1")
  assert.match(badLayer.result, /^Error: unknown raster layer\(s\) nope/)

  const badAt = await a.execute("show_map", { layers: [{ layerId: "asst_rain", at: "March 2026" }] }, state, () => {}, "s1")
  assert.match(badAt.result, /^Error: at must be YYYY-MM-DD/)

  const both = await a.execute(
    "show_map",
    { overlays: [{ resultId: "q1", geojsonColumn: "gj", lonColumn: "lon", latColumn: "lat" }] },
    state,
    () => {},
    "s1"
  )
  assert.match(both.result, /^Error: overlay q1: give exactly one/)

  const badGeojson = await a.execute("show_map", { overlays: [{ resultId: "q1", geojsonColumn: "name" }] }, state, () => {}, "s1")
  assert.match(badGeojson.result, /does not hold GeoJSON/)

  const ok = await a.execute(
    "show_map",
    { layers: [{ layerId: "asst_rain", at: "2026-03-01" }], overlays: [{ resultId: "q1", geojsonColumn: "gj", popup: "name" }] },
    state,
    () => {},
    "s1"
  )
  assert.equal(ok.result, "Map is shown to the user (1 layer(s), 1 overlay(s), 2 feature(s)).")

  const lonlat = await a.execute("show_map", { overlays: [{ resultId: "q1", lonColumn: "lon", latColumn: "lat" }] }, state, () => {}, "s1")
  assert.match(lonlat.result, /^Map is shown/)

  // Models send "" for optional fields they mean to omit
  const blanks = await a.execute(
    "show_map",
    { overlays: [{ resultId: "q1", geojsonColumn: "gj", lonColumn: "", latColumn: "", color: "", popup: "" }] },
    state,
    () => {},
    "s1"
  )
  assert.match(blanks.result, /^Map is shown/)
})

test("list_schema and lookup_country ground the model", async () => {
  const a = impl()
  const schema = await a.execute("list_schema", {}, initialAssistantState(), () => {}, randomUUID())
  assert.match(schema.result, /asst_sites: name text, level number \(m\), geom geometry/)
  assert.match(schema.result, /asst_rain "asst_rain" \(time-series\): band 1=rain \(mm\)/)

  const country = await a.execute("lookup_country", { query: "madagascar" }, initialAssistantState(), () => {}, "s1")
  assert.match(country.result, /Madagascar \(MDG\): bbox \[/)
})

test("controller: a chat turn stores results and block inputs, then pauses", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "query",
            input: JSON.stringify({ sql: "SELECT name, level FROM asst_sites ORDER BY name" })
          }
        ],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c2",
            toolName: "show_chart",
            input: JSON.stringify({ resultId: "q1", title: "Levels", type: "bar", x: "name", series: ["level"] })
          }
        ],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      {
        content: [{ type: "text" as const, text: "Levels are shown above." }],
        finishReason: "stop" as const,
        usage: USAGE,
        warnings: []
      }
    ]
  })
  const controller = new AgentSessionController(pool, new AssistantImplementation({ pool, model }))
  const sessionId = await controller.createSession(initialAssistantState())
  const stop = await controller.sendMessage(sessionId, "What are the water levels?")

  assert.equal(stop.reason, "awaiting_user")
  assert.equal(stop.text, "Levels are shown above.")

  const row = (
    await pool.query("SELECT status, messages, client_state FROM app.agent_sessions WHERE id = $1", [sessionId])
  ).rows[0]
  assert.equal(row.status, "paused")
  assert.equal(row.client_state.results.q1.rows.length, 3)
  assert.equal(row.client_state.results.q1.sql, "SELECT name, level FROM asst_sites ORDER BY name")

  const messages = row.messages as { role: string; content: { type: string; toolName?: string; input?: unknown; output?: { value: string } }[] }[]
  const queryResult = messages
    .filter(m => m.role === "tool")
    .flatMap(m => m.content)
    .find(p => p.toolName === "query")
  assert.match(queryResult?.output?.value ?? "", /^result_id: q1\n/)
  const chartCall = messages
    .filter(m => m.role === "assistant")
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .find(p => p.type === "tool-call" && p.toolName === "show_chart")
  assert.equal((chartCall?.input as { resultId?: string })?.resultId, "q1")
})

test("controller: stepsPerRun pauses a thrashing turn; the next message runs again", async () => {
  const always = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName: "echo", input: JSON.stringify({ text: "x" }) }],
      finishReason: "tool-calls" as const,
      usage: USAGE,
      warnings: []
    })
  })
  const capped: AgentImplementation<{ count: number }> = {
    kind: "assistant",
    model: always,
    maxSteps: 100,
    stepsPerRun: 2,
    system: () => "test",
    tools: () => ({ echo: tool({ description: "Echo", inputSchema: z.object({ text: z.string() }) }) }),
    execute: async (_name, _input, state) => ({ result: "ok", state: { count: state.count + 1 } })
  }
  const controller = new AgentSessionController(pool, capped)
  const sessionId = await controller.createSession({ count: 0 })

  const first = await controller.sendMessage(sessionId, "go")
  assert.equal(first.reason, "step_limit")

  const second = await controller.sendMessage(sessionId, "again")
  assert.equal(second.reason, "step_limit")

  const row = (await pool.query("SELECT status, usage, client_state FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "paused")
  assert.equal(row.usage.steps, 4)
  assert.equal(row.client_state.count, 4)
})

test("http: viewers chat with the assistant but stay blocked from design", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "Hello! Ask me about the data." }],
      finishReason: "stop" as const,
      usage: USAGE,
      warnings: []
    })
  })
  const assistantAgent = AgentService.forAssistant(pool, { pool, model })
  const server: Server = createApiServer(
    pool,
    new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    assistantAgent
  )
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "viewer@example.org", password: "hunter2hunter2" })
    })
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]
    const headers = { cookie, "content-type": "application/json" }

    const designer = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({}) })
    assert.equal(designer.status, 403)
    const dashboard = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "dashboard" })
    })
    assert.equal(dashboard.status, 403)

    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "assistant" })
    })
    assert.equal(created.status, 201)
    const { sessionId } = (await created.json()) as { sessionId: string }

    const sent = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hi" })
    })
    assert.equal(sent.status, 202)

    // A designer session (seeded directly) rejects viewer messages by kind
    const design = await pool.query(
      "INSERT INTO app.agent_sessions (kind, status, client_state, usage) VALUES ('designer', 'paused', '{}', '{}') RETURNING id"
    )
    const blocked = await fetch(`${base}/api/sessions/${design.rows[0].id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hi" })
    })
    assert.equal(blocked.status, 403)

    // Another user's chat must not appear in this user's list
    const other = await createUser(pool, "other@example.org", "hunter2hunter2", "viewer")
    const foreign = await pool.query(
      "INSERT INTO app.agent_sessions (kind, user_id, status, client_state, usage) VALUES ('assistant', $1, 'paused', '{\"results\":{},\"nextResult\":1}', '{}') RETURNING id",
      [other.id]
    )

    const list = await fetch(`${base}/api/sessions`, { headers: { cookie } })
    assert.equal(list.status, 200)
    const { sessions } = (await list.json()) as { sessions: { id: string; kind: string }[] }
    assert.ok(sessions.some(s => s.id === sessionId && s.kind === "assistant"))
    assert.ok(!sessions.some(s => s.id === foreign.rows[0].id))

    // Detail carries client_state (the block store) to every role
    const detail = await fetch(`${base}/api/sessions/${sessionId}`, { headers: { cookie } })
    assert.equal(detail.status, 200)
    const body = (await detail.json()) as { kind: string; state: { results: object } }
    assert.equal(body.kind, "assistant")
    assert.deepEqual(body.state.results, {})

    // Another user's chat cannot be read, followed or written to
    const foreignId = foreign.rows[0].id
    assert.equal((await fetch(`${base}/api/sessions/${foreignId}`, { headers: { cookie } })).status, 404)
    assert.equal((await fetch(`${base}/api/sessions/${foreignId}/events`, { headers: { cookie } })).status, 404)
    const foreignPost = await fetch(`${base}/api/sessions/${foreignId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hi" })
    })
    assert.equal(foreignPost.status, 404)

    // Delete reaches only your own chats, and only chats
    const foreignDelete = await fetch(`${base}/api/sessions/${foreignId}`, { method: "DELETE", headers: { cookie } })
    assert.equal(foreignDelete.status, 404)
    const designDelete = await fetch(`${base}/api/sessions/${design.rows[0].id}`, { method: "DELETE", headers: { cookie } })
    assert.equal(designDelete.status, 403)
    const survivors = await pool.query("SELECT id FROM app.agent_sessions WHERE id = ANY($1)", [
      [foreign.rows[0].id, design.rows[0].id]
    ])
    assert.equal(survivors.rows.length, 2)

    const own = await fetch(`${base}/api/sessions/${sessionId}`, { method: "DELETE", headers: { cookie } })
    assert.equal(own.status, 200)
    const gone = await fetch(`${base}/api/sessions/${sessionId}`, { headers: { cookie } })
    assert.equal(gone.status, 404)
  } finally {
    server.close()
  }
})

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import pg from "pg"
import { z } from "zod"
import { Runner } from "@data-integrator/runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { getIntegration, listIntegrations } from "../src/integrations.js"
import { AgentSessionController } from "../src/agent/controller.js"
import { DesignerImplementation, DesignerState, initialDesignerState } from "../src/agent/designer.js"
import { AgentService, SessionEvent } from "../src/agent/service.js"
import { AgentImplementation, ToolOutcome } from "../src/agent/types.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

/** V4 usage object for mock generate results. */
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
}

/** Client state for the chassis test implementation. */
interface EchoState {
  count: number
}

/** Minimal implementation: one echo tool that bumps a counter. */
function echoImplementation(model: MockLanguageModelV4, finishOnEcho = false): AgentImplementation<EchoState> {
  return {
    kind: "designer",
    model,
    maxSteps: 10,
    system: () => "You are a test agent.",
    tools: () => ({
      echo: tool({ description: "Echo text", inputSchema: z.object({ text: z.string() }) })
    }),
    execute: async (name, input, state): Promise<ToolOutcome<EchoState>> => {
      assert.equal(name, "echo")
      const text = (input as { text: string }).text
      return { result: `echo:${text}`, state: { count: state.count + 1 }, finished: finishOnEcho }
    }
  }
}

test("controller: tool call round-trip, persistence, and pause on plain text", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "hello" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      {
        content: [{ type: "text" as const, text: "All done" }],
        finishReason: "stop" as const,
        usage: USAGE,
        warnings: []
      }
    ]
  })
  const controller = new AgentSessionController(pool, echoImplementation(model))
  const sessionId = await controller.createSession({ count: 0 })

  const events: string[] = []
  const stop = await controller.sendMessage(sessionId, "go", e => events.push(e.type))

  assert.equal(stop.reason, "awaiting_user")
  assert.equal(stop.text, "All done")
  assert.deepEqual(events, ["tool_start", "tool_end", "assistant_text"])

  const row = (await pool.query("SELECT status, messages, client_state, usage FROM app.agent_sessions WHERE id = $1", [
    sessionId
  ])).rows[0]
  assert.equal(row.status, "paused")
  assert.equal(row.client_state.count, 1)
  assert.equal(row.usage.steps, 2)
  // user, assistant(tool call), tool result, assistant(text)
  assert.equal(row.messages.length, 4)
  assert.equal(row.messages[2].role, "tool")
  assert.equal(row.messages[2].content[0].output.value, "echo:hello")
})

test("controller: a finishing tool ends the session", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "bye" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      }
    ]
  })
  const controller = new AgentSessionController(pool, echoImplementation(model, true))
  const sessionId = await controller.createSession({ count: 0 })
  const stop = await controller.sendMessage(sessionId, "go")

  assert.equal(stop.reason, "finished")
  const row = (await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "finished")
  await assert.rejects(() => controller.sendMessage(sessionId, "more"), /finished/)
})

/** Designer with dummy deps for tools that touch neither runner nor DB. */
function bareDesigner(): DesignerImplementation {
  return new DesignerImplementation({
    pool,
    runner: null as never,
    store: null as never,
    workRoot: "/nonexistent",
    databaseUrl: db.url,
    secretKey: null,
    images: {},
    model: new MockLanguageModelV4({})
  })
}

const noEvents = () => {}

test("designer: edit_code exact-string semantics", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")

  const set = await designer.execute("edit_code", { oldString: "", newString: "a = 1\nb = 2\n" }, state, noEvents)
  assert.match(set.result, /Code updated/)
  const code = (set.state as DesignerState).definition.code
  assert.equal(code, "a = 1\nb = 2\n")

  const reject = await designer.execute("edit_code", { oldString: "", newString: "x" }, set.state as DesignerState, noEvents)
  assert.match(reject.result, /oldString is required/)

  const missing = await designer.execute("edit_code", { oldString: "zzz", newString: "x" }, set.state as DesignerState, noEvents)
  assert.match(missing.result, /not found/)

  const ambiguous = await designer.execute("edit_code", { oldString: "= ", newString: "x" }, set.state as DesignerState, noEvents)
  assert.match(ambiguous.result, /occurs 2 times/)

  const edit = await designer.execute("edit_code", { oldString: "b = 2", newString: "b = 3" }, set.state as DesignerState, noEvents)
  assert.equal((edit.state as DesignerState).definition.code, "a = 1\nb = 3\n")
})

test("designer: write_definition preserves id and code, reports validation", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")
  state.definition.code = "keep me"

  const written = await designer.execute(
    "write_definition",
    {
      definitionJson: JSON.stringify({
        id: "sneaky_rename",
        name: "Demo",
        trigger: { cron: "0 0 * * *" },
        runtime: "python3.12",
        destinations: [
          { kind: "table", tableId: "demo_rows", action: "replace", columns: [{ id: "v", type: "number" }] }
        ],
        code: "overwrite attempt",
        contract: 2
      })
    },
    state,
    noEvents
  )
  assert.match(written.result, /Validation: valid/)
  const next = written.state as DesignerState
  assert.equal(next.definition.id, "demo")
  assert.equal(next.definition.code, "keep me")

  const invalid = await designer.execute("write_definition", { definitionJson: "{not json" }, state, noEvents)
  assert.match(invalid.result, /Invalid JSON/)
  assert.equal(invalid.state, undefined)

  // The live-session failure mode: invented vocabulary ("mode", "timestamp")
  // must be caught at validation, not surface as a Postgres DDL error
  const wrongVocab = await designer.execute(
    "write_definition",
    {
      definitionJson: JSON.stringify({
        id: "demo",
        name: "Demo",
        trigger: {},
        runtime: "node22",
        destinations: [
          { kind: "table", tableId: "demo_rows", mode: "merge", mergeColumns: ["t"], columns: [{ id: "t", type: "timestamp" }] }
        ],
        code: "",
        contract: 2
      })
    },
    state,
    noEvents
  )
  assert.match(wrongVocab.result, /INVALID: Invalid action/)
})

test("designer: finish is rejected without a cold run of the current definition", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")

  const rejected = await designer.execute("finish", { summary: "done" }, state, noEvents)
  assert.equal(rejected.finished, undefined)
  assert.match(rejected.result, /cold run/)

  const stale = { ...state, coldRun: { definitionHash: "not-the-current-hash", runId: "r1" } }
  const staleRejected = await designer.execute("finish", { summary: "done" }, stale, noEvents)
  assert.equal(staleRejected.finished, undefined)
})

test("service: create, send, event fanout, and detail reporting", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "edit_code",
            input: JSON.stringify({ oldString: "", newString: "print('hi')" })
          }
        ],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      { content: [{ type: "text" as const, text: "Code is in place." }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
    ]
  })
  const service = new AgentService(pool, {
    pool,
    runner: { ensureReady: async () => {} } as unknown as Runner,
    store: null as never,
    workRoot: "/nonexistent",
    databaseUrl: db.url,
    secretKey: null,
    images: {},
    model
  })

  const sessionId = await service.createSession("svc_demo")
  await assert.rejects(() => service.createSession("Bad-Id"), /Invalid integration id/)

  const events: SessionEvent[] = []
  const stopped = new Promise<void>(resolve => {
    service.subscribe(sessionId, event => {
      events.push(event)
      if (event.type === "stop" || event.type === "error") resolve()
    })
  })
  await service.send(sessionId, "write hello world")
  await stopped

  assert.deepEqual(
    events.map(e => e.type),
    ["user_message", "tool_start", "tool_end", "assistant_text", "stop"]
  )
  assert.equal(events.at(-1)?.reason, "awaiting_user")

  const detail = await service.getSession(sessionId)
  assert.ok(detail)
  assert.equal(detail.integrationId, "svc_demo")
  assert.equal(detail.state.definition.code, "print('hi')")
  assert.equal(detail.certified, false)
  assert.equal(detail.running, false)
  assert.equal(detail.messages.length, 4)

  const list = await service.listSessions()
  assert.ok(list.some(s => s.id === sessionId && s.integrationId === "svc_demo"))
})

test("integrations API: list and detail reflect an installed definition", async () => {
  const definition: IntegrationDefinition = {
    id: "api_demo",
    name: "API Demo",
    trigger: { cron: "0 0 * * *" },
    runtime: "node22",
    destinations: [
      { kind: "table", tableId: "api_demo_rows", action: "replace", columns: [{ id: "v", type: "number" }] }
    ],
    code: "export default async function run() { return {} }",
    contract: 2
  }
  await installIntegration(pool, definition)

  const list = await listIntegrations(pool)
  const summary = list.find(i => i.id === "api_demo")
  assert.ok(summary)
  assert.equal(summary.name, "API Demo")
  assert.equal(summary.destinations, 1)
  assert.equal(summary.lastRunStatus, null)

  const detail = await getIntegration(pool, "api_demo")
  assert.ok(detail)
  assert.equal(detail.definition.name, "API Demo")
  assert.equal(detail.runs.length, 0)
  // ensureTable ran at install, so the destination exists with zero rows
  assert.deepEqual(detail.destinations, [{ kind: "table", id: "api_demo_rows", count: 0 }])

  assert.equal(await getIntegration(pool, "nope"), null)
})

test("designer: query_table rejects non-SELECT and runs read-only", async () => {
  const designer = bareDesigner()
  const bad = await designer.execute("query_table", { sql: "DELETE FROM data.x" }, initialDesignerState("demo"), noEvents)
  assert.match(bad.result, /SELECT/)
  const stacked = await designer.execute("query_table", { sql: "SELECT 1; SELECT 2" }, initialDesignerState("demo"), noEvents)
  assert.match(stacked.result, /SELECT/)
  const good = await designer.execute("query_table", { sql: "SELECT 1 AS one" }, initialDesignerState("demo"), noEvents)
  assert.match(good.result, /"one":1/)
})

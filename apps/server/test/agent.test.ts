import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import pg from "pg"
import { z } from "zod"
import { Runner } from "@mwater/integration-runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { getIntegration, listIntegrations } from "../src/integrations.js"
import { listSources } from "../src/sources.js"
import { AgentSessionController } from "../src/agent/controller.js"
import { DesignerImplementation, DesignerState, errorSignature, initialDesignerState } from "../src/agent/designer.js"
import { AgentService, SessionEvent } from "../src/agent/service.js"
import { AgentImplementation, ToolOutcome } from "../src/agent/types.js"
import { randomBytes } from "node:crypto"
import { setSecret } from "../src/secrets.js"
import { createDraftSchema, draftSchema } from "../src/scratch.js"
import { aiTokenBudget, aiUsageToday, saveAiLimits } from "../src/aiLimits.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

/** Secret key for credential tests. */
const SECRET_KEY = randomBytes(32)

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

test("controller: daily token caps record usage and refuse model calls once reached", async () => {
  const text = { content: [{ type: "text" as const, text: "ok" }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
  const model = new MockLanguageModelV4({ doGenerate: [text, text] })
  const controller = new AgentSessionController(pool, echoImplementation(model), aiTokenBudget(pool))
  const before = await aiUsageToday(pool, null)
  await saveAiLimits(pool, { userDailyTokens: null, deploymentDailyTokens: before.deployment + 15 })

  const sessionId = await controller.createSession({ count: 0 })
  await controller.sendMessage(sessionId, "first")
  assert.equal((await aiUsageToday(pool, null)).deployment, before.deployment + 15)

  // The cap is reached: the next call is refused before reaching the model, and the session stays resumable
  await assert.rejects(controller.sendMessage(sessionId, "second"), /daily AI allowance/)
  assert.equal(model.doGenerateCalls.length, 1)
  const row = (await pool.query("SELECT status, error FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "paused")
  assert.match(row.error, /daily AI allowance/)

  await saveAiLimits(pool, { userDailyTokens: null, deploymentDailyTokens: null })
  assert.equal((await controller.sendMessage(sessionId, "third")).reason, "awaiting_user")
})

test("controller: a finishing tool marks the session finished but it stays continuable", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "bye" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      { content: [{ type: "text" as const, text: "back again" }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
    ]
  })
  const controller = new AgentSessionController(pool, echoImplementation(model, true))
  const sessionId = await controller.createSession({ count: 0 })
  const stop = await controller.sendMessage(sessionId, "go")

  assert.equal(stop.reason, "finished")
  const row = (await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "finished")

  // "finished" is a badge, not a terminal state: the session accepts more work
  const again = await controller.sendMessage(sessionId, "more")
  assert.equal(again.reason, "awaiting_user")
  const after = (await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(after.status, "paused")
})

test("controller: a pausing tool stops the loop as awaiting_user", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "x" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      { content: [{ type: "text" as const, text: "must not run" }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
    ]
  })
  const impl: AgentImplementation<EchoState> = {
    kind: "designer",
    model,
    maxSteps: 10,
    system: () => "t",
    tools: () => ({ echo: tool({ description: "e", inputSchema: z.object({ text: z.string() }) }) }),
    execute: async () => ({ result: "stopping for guidance", pause: true })
  }
  const controller = new AgentSessionController(pool, impl)
  const sessionId = await controller.createSession({ count: 0 })
  const stop = await controller.sendMessage(sessionId, "go")

  assert.equal(stop.reason, "awaiting_user")
  const row = (await pool.query("SELECT status, usage FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "paused")
  assert.equal(row.usage.steps, 1)
})

test("controller: steering lands at the next step boundary", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "one" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      },
      { content: [{ type: "text" as const, text: "done" }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
    ]
  })
  const controller = new AgentSessionController(pool, echoImplementation(model))
  const sessionId = await controller.createSession({ count: 0 })

  let iteration = 0
  await controller.sendMessage(sessionId, "go", undefined, {
    drainSteering: () => (++iteration === 2 ? ["actually include units"] : [])
  })

  const row = (await pool.query("SELECT messages FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  const roles = row.messages.map((m: { role: string }) => m.role)
  assert.deepEqual(roles, ["user", "assistant", "tool", "user", "assistant"])
  assert.equal(row.messages[3].content, "actually include units")
})

test("controller: stop before tool execution cancels the calls", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "echo", input: JSON.stringify({ text: "x" }) }],
        finishReason: "tool-calls" as const,
        usage: USAGE,
        warnings: []
      }
    ]
  })
  let executed = false
  const impl: AgentImplementation<EchoState> = {
    kind: "designer",
    model,
    maxSteps: 10,
    system: () => "t",
    tools: () => ({ echo: tool({ description: "e", inputSchema: z.object({ text: z.string() }) }) }),
    execute: async () => {
      executed = true
      return { result: "ran" }
    }
  }
  const controller = new AgentSessionController(pool, impl)
  const sessionId = await controller.createSession({ count: 0 })

  let checks = 0
  const stop = await controller.sendMessage(sessionId, "go", undefined, {
    stopRequested: () => ++checks > 1 // false at the iteration top, true before tools run
  })

  assert.equal(stop.reason, "stopped")
  assert.equal(executed, false)
  const row = (await pool.query("SELECT status, messages FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "paused")
  const last = row.messages.at(-1)
  assert.equal(last.role, "tool")
  assert.match(last.content[0].output.value, /Cancelled/)
})

test("controller: stop at the iteration top pauses without a model call", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [] })
  const controller = new AgentSessionController(pool, echoImplementation(model))
  const sessionId = await controller.createSession({ count: 0 })
  const stop = await controller.sendMessage(sessionId, "go", undefined, { stopRequested: () => true })
  assert.equal(stop.reason, "stopped")
  const row = (await pool.query("SELECT status, usage, messages FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(row.status, "paused")
  assert.equal(row.usage.steps, 0)
  assert.equal(row.messages.at(-1).role, "user")
})

test("controller: a loop crash persists the session as paused with the error", async () => {
  const broken = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("provider exploded")
    }
  })
  const controller = new AgentSessionController(pool, echoImplementation(broken))
  const sessionId = await controller.createSession({ count: 0 })
  await assert.rejects(() => controller.sendMessage(sessionId, "go"), /provider exploded/)

  const row = (await pool.query("SELECT status, error, messages FROM app.agent_sessions WHERE id = $1", [sessionId]))
    .rows[0]
  assert.equal(row.status, "paused")
  assert.match(row.error, /provider exploded/)
  // The triggering user message is preserved, so a later send resumes with context
  assert.equal(row.messages.at(-1).role, "user")

  const working = new MockLanguageModelV4({
    doGenerate: [
      { content: [{ type: "text" as const, text: "back" }], finishReason: "stop" as const, usage: USAGE, warnings: [] }
    ]
  })
  await new AgentSessionController(pool, echoImplementation(working)).sendMessage(sessionId, "again")
  const cleared = (await pool.query("SELECT error FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
  assert.equal(cleared.error, null)
})

test("designer: ask_user pauses with valid options and rejects degenerate input", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")

  const asked = await designer.execute(
    "ask_user",
    { question: "Which dataset?", options: ["Constrained 100m", "Unconstrained 1km"] },
    state,
    noEvents,
    SID
  )
  assert.equal(asked.pause, true)
  assert.match(asked.result, /paused for the user/)

  const tooFew = await designer.execute("ask_user", { question: "Q?", options: ["only one"] }, state, noEvents, SID)
  assert.equal(tooFew.pause, undefined)
  assert.match(tooFew.result, /at least two/)

  const noQuestion = await designer.execute("ask_user", { options: ["a", "b"] }, state, noEvents, SID)
  assert.match(noQuestion.result, /question is required/)
})

test("designer: skills index in the system prompt, read_skill serves full text", async () => {
  // Without a skills dir: no index section, tool degrades gracefully
  const bare = bareDesigner()
  assert.ok(!bare.system().includes("# Skills"))
  const none = await bare.execute("read_skill", { id: "anything" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(none.result, /No skills library/)

  // With the shipped library skills
  const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library", "skills")
  const designer = new DesignerImplementation({
    pool,
    runner: null as never,
    store: null as never,
    workRoot: "/nonexistent",
    databaseUrl: db.url,
    secretKey: null,
    images: {},
    model: new MockLanguageModelV4({}),
    skillsDir
  })
  const system = designer.system()
  assert.ok(system.includes("# Skills"))
  assert.match(system, /- chirps_source: /)

  const read = await designer.execute("read_skill", { id: "chirps_source" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(read.result, /africa_monthly/)

  const unknown = await designer.execute("read_skill", { id: "nope" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(unknown.result, /No skill "nope"/)
  assert.match(unknown.result, /chirps_source/)
})

test("designer: lookup_country serves baked-in boxes by name or ISO3", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")

  const byIso3 = await designer.execute("lookup_country", { query: "mdg" }, state, noEvents, SID)
  assert.match(byIso3.result, /Madagascar \(MDG\): bbox \[43\.257, -25\.571, 50\.483, -12\.08\]/)

  const byName = await designer.execute("lookup_country", { query: "angol" }, state, noEvents, SID)
  assert.match(byName.result, /Angola \(AGO\)/)
  assert.match(byName.result, /west, south, east, north/)

  const none = await designer.execute("lookup_country", { query: "atlantis" }, state, noEvents, SID)
  assert.match(none.result, /No country matches/)

  const empty = await designer.execute("lookup_country", {}, state, noEvents, SID)
  assert.match(empty.result, /query is required/)
})

test("designer: error signatures ignore tmp path noise", () => {
  const a = errorSignature("gdalinfo failed: /tmp/job-out-AbC123/pop.tif missing")
  const b = errorSignature("gdalinfo failed: /tmp/job-out-Zz9xYy/pop.tif missing")
  assert.equal(a, b)
  assert.notEqual(a, errorSignature("something else entirely"))
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

/** Session id for direct designer.execute calls (keys scratch areas). */
const SID = "9f28c9a2-1111-4222-8333-444455556666"

test("designer: edit_code exact-string semantics", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState("demo")

  const set = await designer.execute("edit_code", { oldString: "", newString: "a = 1\nb = 2\n" }, state, noEvents, SID)
  assert.match(set.result, /Code updated/)
  const code = (set.state as DesignerState).definition.code
  assert.equal(code, "a = 1\nb = 2\n")

  const reject = await designer.execute("edit_code", { oldString: "", newString: "x" }, set.state as DesignerState, noEvents, SID)
  assert.match(reject.result, /oldString is required/)

  const missing = await designer.execute("edit_code", { oldString: "zzz", newString: "x" }, set.state as DesignerState, noEvents, SID)
  assert.match(missing.result, /not found/)

  const ambiguous = await designer.execute("edit_code", { oldString: "= ", newString: "x" }, set.state as DesignerState, noEvents, SID)
  assert.match(ambiguous.result, /occurs 2 times/)

  const edit = await designer.execute("edit_code", { oldString: "b = 2", newString: "b = 3" }, set.state as DesignerState, noEvents, SID)
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
        runtime: "python",
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

  const invalid = await designer.execute("write_definition", { definitionJson: "{not json" }, state, noEvents, SID)
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
        runtime: "node",
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

  const rejected = await designer.execute("finish", { summary: "done" }, state, noEvents, SID)
  assert.equal(rejected.finished, undefined)
  assert.match(rejected.result, /cold run/)

  const stale = { ...state, coldRun: { definitionHash: "not-the-current-hash", runId: "r1" } }
  const staleRejected = await designer.execute("finish", { summary: "done" }, stale, noEvents, SID)
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
  const service = AgentService.forDesigner(pool, {
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
  const row = list.find(s => s.id === sessionId)
  assert.equal(row?.integrationId, "svc_demo")
  assert.equal(row?.firstMessage, "write hello world")

  const unboundId = await service.createSession()
  const unbound = await service.getSession(unboundId)
  assert.equal(unbound?.integrationId, null)
  assert.equal(unbound?.firstMessage, null)
})

test("designer: an unbound draft is named by the first write_definition", async () => {
  const designer = bareDesigner()
  const state = initialDesignerState()

  const snippet = await designer.execute("run_snippet", { code: "print(1)" }, state, noEvents, SID)
  assert.match(snippet.result, /No image configured/)
  const run = await designer.execute("run_integration", { cold: false }, state, noEvents, SID)
  assert.match(run.result, /no integration id/)

  const defJson = (id: string) =>
    JSON.stringify({ id, name: { _base: "en", en: id }, trigger: {}, runtime: "python", destinations: [], code: "", contract: 2 })

  const badId = await designer.execute("write_definition", { definitionJson: defJson("Bad-Id") }, state, noEvents, SID)
  assert.match(badId.result, /Invalid integration id/)
  assert.equal(badId.state, undefined)

  await installIntegration(pool, JSON.parse(defJson("name_taken")) as IntegrationDefinition)
  const taken = await designer.execute("write_definition", { definitionJson: defJson("name_taken") }, state, noEvents, SID)
  assert.match(taken.result, /already installed/)
  assert.equal(taken.state, undefined)

  const events: SessionEvent[] = []
  const bound = await designer.execute(
    "write_definition",
    { definitionJson: defJson("fresh_name") },
    state,
    e => events.push(e as SessionEvent),
    SID
  )
  assert.match(bound.result, /Validation: valid/)
  assert.equal((bound.state as DesignerState).definition.id, "fresh_name")
  assert.deepEqual(events, [{ type: "integration_bound", integrationId: "fresh_name" }])

  // Once bound, the id is pinned like any other session
  const renamed = await designer.execute(
    "write_definition",
    { definitionJson: defJson("other_name") },
    bound.state as DesignerState,
    noEvents
  )
  assert.equal((renamed.state as DesignerState).definition.id, "fresh_name")
})

test("integrations API: list and detail reflect an installed definition", async () => {
  const definition: IntegrationDefinition = {
    id: "api_demo",
    name: { _base: "en", en: "API Demo" },
    trigger: { cron: "0 0 * * *" },
    runtime: "node",
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
  assert.deepEqual(summary.name, { _base: "en", en: "API Demo" })
  assert.equal(summary.destinations, 1)
  assert.equal(summary.status, "ready")
  assert.equal(summary.lastRunStatus, null)

  const detail = await getIntegration(pool, "api_demo")
  assert.ok(detail)
  assert.deepEqual(detail.definition.name, { _base: "en", en: "API Demo" })
  assert.equal(detail.runs.length, 0)
  // ensureTable ran at install, so the destination exists with zero rows
  assert.deepEqual(detail.destinations, [{ kind: "table", id: "api_demo_rows", count: 0 }])

  assert.equal(await getIntegration(pool, "nope"), null)
})

test("sources: the catalog lists destination tables of installed integrations", async () => {
  const sources = await listSources(pool)
  const table = sources.find(s => s.kind === "table" && s.id === "api_demo_rows")
  assert.ok(table)
  assert.equal(table.integrationId, "api_demo")
  assert.deepEqual(table.integrationName, { _base: "en", en: "API Demo" })
  assert.equal(table.rows, 0) // table exists from install; nothing has run
  assert.equal(table.columns, 1)
  assert.equal(table.updatedAt, null)
})

test("integrations: design-session installs stay draft until promoted", async () => {
  const definition: IntegrationDefinition = {
    id: "draft_demo",
    name: { _base: "en", en: "Draft Demo" },
    trigger: {},
    runtime: "node",
    destinations: [],
    code: "export default async function run() { return {} }",
    contract: 2
  }
  await installIntegration(pool, definition, "draft")
  assert.equal((await getIntegration(pool, "draft_demo"))?.status, "draft")
  assert.equal((await listIntegrations(pool)).find(i => i.id === "draft_demo")?.status, "draft")

  // What the designer does after a successful cold run
  await pool.query("UPDATE app.integrations SET status = 'ready' WHERE id = $1", ["draft_demo"])
  assert.equal((await getIntegration(pool, "draft_demo"))?.status, "ready")

  // Editing a ready integration reinstalls it as a draft again
  await installIntegration(pool, definition, "draft")
  assert.equal((await getIntegration(pool, "draft_demo"))?.status, "draft")
})

test("designer: query_table rejects non-SELECT and runs read-only", async () => {
  const designer = bareDesigner()
  const bad = await designer.execute("query_table", { sql: "DELETE FROM data.x" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(bad.result, /SELECT/)
  const stacked = await designer.execute("query_table", { sql: "SELECT 1; SELECT 2" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(stacked.result, /SELECT/)
  const good = await designer.execute("query_table", { sql: "SELECT 1 AS one" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(good.result, /"one":1/)

  // Scratch tables read by plain name; the app schema stays out of reach
  await createDraftSchema(pool, SID)
  await pool.query(`CREATE TABLE ${draftSchema(SID)}.readings AS SELECT 7 AS level`)
  const scratch = await designer.execute("query_table", { sql: "SELECT level FROM readings" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(scratch.result, /"level":7/)
  const users = await designer.execute("query_table", { sql: "SELECT password_hash FROM app.users" }, initialDesignerState("demo"), noEvents, SID)
  assert.match(users.result, /Query error: permission denied/)
  await pool.query(`DROP SCHEMA ${draftSchema(SID)} CASCADE`)
})

/** Designer with a real secret key, for tools that read or write credentials. */
function keyedDesigner(): DesignerImplementation {
  return new DesignerImplementation({
    pool,
    runner: null as never,
    store: null as never,
    workRoot: "/nonexistent",
    databaseUrl: db.url,
    secretKey: SECRET_KEY,
    images: {},
    model: new MockLanguageModelV4({})
  })
}

/** A valid draft bound to the given id, saved as a draft row through write_definition. */
async function savedDraft(designer: DesignerImplementation, id: string): Promise<DesignerState> {
  const written = await designer.execute(
    "write_definition",
    {
      definitionJson: JSON.stringify({
        id,
        name: "Secret demo",
        description: "Reads a protected API",
        trigger: {},
        runtime: "python",
        destinations: [{ kind: "table", tableId: `${id}_rows`, action: "replace", columns: [{ id: "v", type: "number" }] }],
        contract: 2
      })
    },
    initialDesignerState(id),
    noEvents,
    SID
  )
  assert.match(written.result, /Validation: valid/)
  return written.state as DesignerState
}

test("designer: request_secrets declares names, pauses, and reports already-set ones", async () => {
  const designer = keyedDesigner()

  const unbound = await designer.execute("request_secrets", { secrets: [{ name: "k", purpose: "p" }] }, initialDesignerState(), noEvents, SID)
  assert.match(unbound.result, /write_definition first/)

  const state = await savedDraft(designer, "secretdemo")
  const badName = await designer.execute("request_secrets", { secrets: [{ name: "9bad", purpose: "p" }] }, state, noEvents, SID)
  assert.match(badName.result, /invalid secret name/)
  const noPurpose = await designer.execute("request_secrets", { secrets: [{ name: "api_key", purpose: "" }] }, state, noEvents, SID)
  assert.match(noPurpose.result, /purpose is required/)
  const badCopy = await designer.execute(
    "request_secrets",
    { secrets: [{ name: "api_key", purpose: "p", copyFrom: "nowhere" }] },
    state,
    noEvents,
    SID
  )
  assert.match(badCopy.result, /holds no secret named api_key/)

  const asked = await designer.execute(
    "request_secrets",
    {
      secrets: [
        { name: "api_key", purpose: "API key for example.org", help: "https://example.org/keys", check: "print('ok')" },
        { name: "TENANT", purpose: "Tenant id" }
      ]
    },
    state,
    noEvents,
    SID
  )
  assert.equal(asked.pause, true)
  assert.match(asked.result, /Credentials requested: api_key, TENANT/)
  const next = asked.state as DesignerState
  assert.deepEqual(next.definition.secrets, ["api_key", "TENANT"])
  assert.equal(next.secretRequest?.items.length, 2)
  assert.equal(next.secretRequest?.items[0].check, "print('ok')")
  const row = await pool.query("SELECT definition->'secrets' AS s, status FROM app.integrations WHERE id = 'secretdemo'")
  assert.deepEqual(row.rows[0].s, ["api_key", "TENANT"])
  assert.equal(row.rows[0].status, "draft")

  // The names-only listing shows nothing yet; storing values changes both answers
  const none = await designer.execute("list_secrets", {}, next, noEvents, SID)
  assert.match(none.result, /No credentials are stored/)
  await setSecret(pool, SECRET_KEY, "secretdemo", "api_key", "v1")
  await setSecret(pool, SECRET_KEY, "secretdemo", "TENANT", "t")
  const listed = await designer.execute("list_secrets", {}, next, noEvents, SID)
  assert.match(listed.result, /api_key \(held by secretdemo\)/)
  assert.ok(!listed.result.includes("v1"), "values never appear")
  const again = await designer.execute(
    "request_secrets",
    { secrets: [{ name: "api_key", purpose: "API key" }] },
    next,
    noEvents,
    SID
  )
  assert.equal(again.pause, undefined)
  assert.match(again.result, /already set: api_key/)
})

test("designer: a run with a missing credential is refused before any job, pointing at request_secrets", async () => {
  const designer = keyedDesigner()
  const state = await savedDraft(designer, "secretdemo_missing")
  state.definition = { ...state.definition, secrets: ["nope_key"], code: "def run(ctx): ..." }
  // runner is null: reaching the job would throw, so the refusal must come first
  const refused = await designer.execute("run_integration", { cold: true }, state, noEvents, SID)
  assert.match(refused.result, /Secret nope_key is not set/)
  assert.match(refused.result, /request_secrets/)
  const runs = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE session_id = $1", [SID])
  assert.equal(runs.rows[0].n, 0)
})

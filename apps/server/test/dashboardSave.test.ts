import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { LanguageModel } from "ai"
import { migrate } from "../src/migrations.js"
import { DashboardAgentState, DashboardImplementation, saveDashboardSession } from "../src/agent/dashboard.js"
import { AgentService } from "../src/agent/service.js"
import { listDashboards, renameDashboard } from "../src/dashboards/service.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool

const SOURCE = "export default function Dashboard() { return null }"

/** A built, never-saved draft with the agent's proposal, as ready_to_save leaves it. */
function draft(overrides: Partial<DashboardAgentState> = {}): DashboardAgentState {
  return {
    dashboardId: "",
    name: "Water Points",
    source: SOURCE,
    queries: [],
    layers: [],
    build: { rev: 1, ok: true, errors: [] },
    saved: null,
    dirty: true,
    proposed: { id: "water_points", name: "Water Points" },
    schemas: "",
    ...overrides
  }
}

/** Inserts a dashboard design session holding the given state. */
async function session(state: object): Promise<string> {
  const row = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, messages, client_state, usage)
     VALUES ('dashboard', 'paused', '[]', $1, '{}') RETURNING id`,
    [JSON.stringify(state)]
  )
  return row.rows[0].id
}

const stateOf = async (id: string) =>
  (await pool.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [id])).rows[0].client_state as DashboardAgentState

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool?.end()
  await db?.stop()
})

test("first save takes the agent's proposal, binds the session and clears unsaved", { skip: !AVAILABLE }, async () => {
  const id = await session(draft())
  const result = await saveDashboardSession(pool, id, {})
  assert.ok(result.ok, result.ok ? "" : result.error)
  assert.equal(result.dashboardId, "water_points")
  assert.equal(result.version, 1)

  const state = await stateOf(id)
  assert.equal(state.dashboardId, "water_points")
  assert.deepEqual(state.saved, { version: 1 })
  assert.equal(state.dirty, false)
  assert.ok((await listDashboards(pool)).some(d => d.id === "water_points" && d.name === "Water Points"))

  // Edits after the save mark it unsaved again; the next save is version 2 on the same slug
  await pool.query(
    "UPDATE app.agent_sessions SET client_state = jsonb_set(client_state, '{dirty}', 'true') WHERE id = $1",
    [id]
  )
  const user = await pool.query(
    "INSERT INTO app.users (email, password_hash, role) VALUES ('saver@example.org', 'x', 'editor') RETURNING id"
  )
  const again = await saveDashboardSession(pool, id, { id: "ignored_once_bound" }, user.rows[0].id)
  assert.ok(again.ok)
  assert.deepEqual([again.dashboardId, again.version], ["water_points", 2])
  const author = await pool.query(
    "SELECT created_by FROM app.dashboard_versions WHERE dashboard_id = 'water_points' AND version = 2"
  )
  assert.equal(author.rows[0].created_by, user.rows[0].id)
})

test("a new draft cannot take an address another dashboard already has", { skip: !AVAILABLE }, async () => {
  const id = await session(draft())
  const clash = await saveDashboardSession(pool, id, {})
  assert.equal(clash.ok, false)
  assert.match(clash.ok ? "" : clash.error, /already uses the address #\/dashboard\/water_points/)
  // The existing dashboard was not touched
  const versions = await pool.query("SELECT count(*)::int AS n FROM app.dashboard_versions WHERE dashboard_id = 'water_points'")
  assert.equal(versions.rows[0].n, 2)

  const chosen = await saveDashboardSession(pool, id, { id: "water_points_north", name: "North" })
  assert.ok(chosen.ok)
  assert.deepEqual([chosen.dashboardId, chosen.version], ["water_points_north", 1])
  assert.equal((await stateOf(id)).name, "North")
})

test("a draft whose latest build failed cannot be saved", { skip: !AVAILABLE }, async () => {
  const id = await session(draft({ build: { rev: 2, ok: false, errors: ["boom"] }, proposed: { id: "broken", name: "Broken" } }))
  const result = await saveDashboardSession(pool, id, {})
  assert.equal(result.ok, false)
  assert.match(result.ok ? "" : result.error, /latest build has errors/)
  assert.equal((await pool.query("SELECT 1 FROM app.dashboards WHERE id = 'broken'")).rows.length, 0)
})

test("renaming a dashboard moves open sessions with it, so their next save follows", { skip: !AVAILABLE }, async () => {
  const id = await session(draft({ proposed: { id: "rename_me", name: "Rename Me" } }))
  assert.ok((await saveDashboardSession(pool, id, {})).ok)
  assert.deepEqual(await renameDashboard(pool, "rename_me", "renamed", null), { ok: true })
  assert.equal((await stateOf(id)).dashboardId, "renamed")

  const result = await saveDashboardSession(pool, id, {})
  assert.ok(result.ok)
  assert.deepEqual([result.dashboardId, result.version], ["renamed", 2])
  assert.equal((await pool.query("SELECT 1 FROM app.dashboards WHERE id = 'rename_me'")).rows.length, 0)
})

test("the agent proposes but never saves; its edits mark the draft unsaved", { skip: !AVAILABLE }, async () => {
  const agent = new DashboardImplementation({ pool, model: {} as LanguageModel })
  const noEvents = () => {}
  const failed = await agent.execute("ready_to_save", { id: "x", name: "X" }, draft({ build: null }), noEvents, "s")
  assert.match(failed.result, /rejected/)

  const ready = await agent.execute("ready_to_save", { id: "agent_pick", name: "Agent Pick" }, draft({ proposed: null }), noEvents, "s")
  assert.equal(ready.pause, true)
  assert.deepEqual(ready.state?.proposed, { id: "agent_pick", name: "Agent Pick" })
  assert.equal((await pool.query("SELECT 1 FROM app.dashboards WHERE id = 'agent_pick'")).rows.length, 0, "nothing saved")

  const edited = await agent.execute("set_queries", { queries: [] }, draft({ dirty: false }), noEvents, "s")
  assert.equal(edited.state?.dirty, true)
})

test("session list flags unsaved drafts", { skip: !AVAILABLE }, async () => {
  const service = AgentService.forDashboard(pool, { pool, model: {} as LanguageModel })
  const unsaved = await session(draft({ proposed: null }))
  const clean = await session(draft({ dirty: false, saved: { version: 1 }, dashboardId: "water_points" }))

  const flags = Object.fromEntries((await service.listSessions()).map(s => [s.id, s.unsaved]))
  assert.equal(flags[unsaved], true)
  assert.equal(flags[clean], false)
})

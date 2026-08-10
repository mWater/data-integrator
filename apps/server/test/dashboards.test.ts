import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { deleteDashboard, listDashboards } from "../src/dashboards/service.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool

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

/** Inserts a dashboard with two versions and a bound design session. */
async function seed(id: string): Promise<string> {
  await pool.query("INSERT INTO app.dashboards (id, name) VALUES ($1, $2)", [id, `Dashboard ${id}`])
  for (const version of [1, 2]) {
    await pool.query(
      `INSERT INTO app.dashboard_versions
         (dashboard_id, version, source, queries, kit_version, bundle_js, bundle_css)
       VALUES ($1, $2, 'export default () => null', '[]', '2', 'js', 'css')`,
      [id, version]
    )
  }
  await pool.query("UPDATE app.dashboards SET current_version = 2 WHERE id = $1", [id])
  const session = await pool.query(
    `INSERT INTO app.agent_sessions (kind, dashboard_id, status, client_state, usage)
     VALUES ('dashboard', $1, 'paused', '{}', '{}') RETURNING id`,
    [id]
  )
  return session.rows[0].id as string
}

test("deleteDashboard removes the dashboard and its versions, keeping sessions", { skip: !AVAILABLE }, async () => {
  const sessionId = await seed("del_dash")

  const result = await deleteDashboard(pool, "del_dash")
  assert.deepEqual(result, { ok: true, versions: 2, sessions: 1 })

  const dashboards = await listDashboards(pool)
  assert.equal(dashboards.some(d => d.id === "del_dash"), false)
  const versions = await pool.query("SELECT 1 FROM app.dashboard_versions WHERE dashboard_id = $1", ["del_dash"])
  assert.equal(versions.rows.length, 0)

  // The design transcript outlives the dashboard, unbound
  const session = await pool.query("SELECT dashboard_id FROM app.agent_sessions WHERE id = $1", [sessionId])
  assert.equal(session.rows.length, 1)
  assert.equal(session.rows[0].dashboard_id, null)
})

test("deleteDashboard reports an unknown id without touching others", { skip: !AVAILABLE }, async () => {
  await seed("keep_dash")

  assert.deepEqual(await deleteDashboard(pool, "no_such_dash"), { ok: false, versions: 0, sessions: 0 })

  const kept = await pool.query("SELECT current_version FROM app.dashboards WHERE id = $1", ["keep_dash"])
  assert.equal(kept.rows[0].current_version, 2)
})

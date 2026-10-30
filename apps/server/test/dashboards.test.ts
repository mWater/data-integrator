import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { deleteDashboard, listDashboards, listDashboardVersions, restoreDashboardVersion } from "../src/dashboards/service.js"
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
       VALUES ($1, $2, 'export default () => null', '[]', '2', $3, 'css')`,
      [id, version, `js${version}`]
    )
  }
  await pool.query("UPDATE app.dashboards SET current_version = 2 WHERE id = $1", [id])
  const session = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, client_state, usage)
     VALUES ('dashboard', 'paused', jsonb_build_object('dashboardId', $1::text, 'saved', '{"version": 2}'::jsonb, 'dirty', false), '{}')
     RETURNING id`,
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

  // The design transcript outlives the dashboard, as an unsaved draft
  const session = await pool.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [sessionId])
  assert.equal(session.rows.length, 1)
  assert.deepEqual([session.rows[0].client_state.saved, session.rows[0].client_state.dirty], [null, true])
})

test("deleteDashboard reports an unknown id without touching others", { skip: !AVAILABLE }, async () => {
  await seed("keep_dash")

  assert.deepEqual(await deleteDashboard(pool, "no_such_dash"), { ok: false, versions: 0, sessions: 0 })

  const kept = await pool.query("SELECT current_version FROM app.dashboards WHERE id = $1", ["keep_dash"])
  assert.equal(kept.rows[0].current_version, 2)
})

test("restoreDashboardVersion copies the version as the new current one", { skip: !AVAILABLE }, async () => {
  const sessionId = await seed("restore_dash")
  const user = await pool.query(
    "INSERT INTO app.users (email, password_hash, role) VALUES ('restorer@example.org', 'x', 'editor') RETURNING id"
  )

  assert.deepEqual(await restoreDashboardVersion(pool, "restore_dash", 1, user.rows[0].id), { ok: true, version: 3 })

  const current = await pool.query(
    `SELECT v.bundle_js FROM app.dashboards d
     JOIN app.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.current_version
     WHERE d.id = $1`,
    ["restore_dash"]
  )
  assert.equal(current.rows[0].bundle_js, "js1")
  const versions = await listDashboardVersions(pool, "restore_dash")
  assert.deepEqual(
    versions?.map(v => [v.version, v.createdBy, v.restoredFrom]),
    [[3, "restorer@example.org", 1], [2, null, null], [1, null, null]]
  )

  // An open design session keeps its draft, now unsaved against the restored version
  const session = await pool.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [sessionId])
  assert.deepEqual([session.rows[0].client_state.saved, session.rows[0].client_state.dirty], [{ version: 3 }, true])
})

test("restoreDashboardVersion refuses the current version and unknown ones", { skip: !AVAILABLE }, async () => {
  await seed("restore_refused")
  const user = await pool.query(
    "INSERT INTO app.users (email, password_hash, role) VALUES ('refused@example.org', 'x', 'editor') RETURNING id"
  )
  const userId = user.rows[0].id

  assert.equal((await restoreDashboardVersion(pool, "restore_refused", 2, userId)).ok, false)
  assert.equal((await restoreDashboardVersion(pool, "restore_refused", 9, userId)).notFound, true)
  assert.equal((await restoreDashboardVersion(pool, "no_such_dash", 1, userId)).notFound, true)
  assert.equal(await listDashboardVersions(pool, "no_such_dash"), null)

  const kept = await pool.query("SELECT current_version FROM app.dashboards WHERE id = $1", ["restore_refused"])
  assert.equal(kept.rows[0].current_version, 2)
})

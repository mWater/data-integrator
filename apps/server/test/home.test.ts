import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { getHomeSummary } from "../src/home.js"
import { installIntegration, validateDefinition } from "../src/install.js"
import { ExecutorDeps } from "../src/executor.js"
import { RunService } from "../src/runService.js"
import { migrate } from "../src/migrations.js"
import { DEFAULT_SITE_TITLE, parseSiteTitle, setSetting, SITE_TITLE_KEY } from "../src/settings.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** No model configured: the shape the welcome state falls back to. */
const NO_AI = { designer: false, dashboards: false, assistant: false }

let db: TestDb
let pool: pg.Pool

/** Healthy integration: one table that receives rows. */
const LOADER: IntegrationDefinition = {
  id: "home_loader",
  name: { _base: "en", en: "Home loader" },
  trigger: {},
  runtime: "python",
  destinations: [
    { kind: "table", tableId: "home_rows", action: "append", columns: [{ id: "site", type: "text" }] }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

/** Broken integration: declares a table but its latest run failed. */
const BROKEN: IntegrationDefinition = {
  id: "home_broken",
  name: { _base: "en", en: "Home broken" },
  trigger: {},
  runtime: "python",
  destinations: [
    { kind: "table", tableId: "home_empty", action: "append", columns: [{ id: "site", type: "text" }] }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

test("empty deployment: no integrations, no data, no problems", async () => {
  const home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.hasData, false)
  assert.equal(home.counts.integrations, 0)
  assert.equal(home.counts.tables, 0)
  assert.equal(home.counts.rasters, 0)
  assert.deepEqual(home.problems, [])
  // No library path configured, so there is nothing to count
  assert.equal(home.counts.library, null)
  assert.deepEqual(home.ai, NO_AI)
})

test("a declared but empty table does not count as data", async () => {
  await installIntegration(pool, LOADER)
  const home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.counts.integrations, 1)
  // The table exists with zero rows: the page must stay in its welcome state
  assert.equal(home.hasData, false)
  assert.equal(home.counts.tables, 0)
  assert.equal(home.sources.length, 0)
  assert.equal(home.integrations.length, 1)
  assert.equal(home.integrations[0].id, "home_loader")
  assert.equal(home.integrations[0].lastRunStatus, null)
})

test("rows switch the page into its active state", async () => {
  const run = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status, finished_at) VALUES ('home_loader', 'manual', 'succeeded', now()) RETURNING id"
  )
  await pool.query("INSERT INTO data.home_rows (site, _run_id) VALUES ('a', $1), ('b', $1)", [run.rows[0].id])

  const home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.hasData, true)
  assert.equal(home.counts.tables, 1)
  assert.equal(home.sources.length, 1)
  assert.equal(home.sources[0].id, "home_rows")
  assert.equal(home.sources[0].rows, 2)
  assert.ok(home.sources[0].updatedAt)
  // Counting the library costs a read per entry, so it is skipped once integrations exist
  assert.equal(home.counts.library, null)
})

test("only the most recent run decides whether an integration is a problem", async () => {
  await installIntegration(pool, BROKEN)
  await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status, scheduled_at, finished_at, error)
     VALUES ('home_broken', 'cron', 'failed', now() - interval '2 hours', now() - interval '2 hours', 'boom')`
  )
  let home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.problems.length, 1)
  assert.equal(home.problems[0].id, "home_broken")
  assert.equal(home.problems[0].status, "failed")
  assert.equal(home.problems[0].error, "boom")

  // A later success clears it, even though the failed run is still on record
  await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status, scheduled_at, finished_at)
     VALUES ('home_broken', 'cron', 'succeeded', now(), now())`
  )
  home = await getHomeSummary(pool, null, NO_AI)
  assert.deepEqual(home.problems, [])
})

test("a paused integration is not reported as a problem", async () => {
  await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status, scheduled_at, finished_at, error)
     VALUES ('home_broken', 'cron', 'timeout', now() + interval '1 hour', now() + interval '1 hour', 'slow')`
  )
  let home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.problems.length, 1)
  assert.equal(home.problems[0].status, "timeout")

  await pool.query("UPDATE app.integrations SET enabled = false WHERE id = 'home_broken'")
  home = await getHomeSummary(pool, null, NO_AI)
  assert.deepEqual(home.problems, [])
  await pool.query("UPDATE app.integrations SET enabled = true WHERE id = 'home_broken'")
})

test("a draft integration is not reported as a problem and cannot be run", async () => {
  await pool.query("UPDATE app.integrations SET status = 'draft' WHERE id = 'home_broken'")
  const home = await getHomeSummary(pool, null, NO_AI)
  assert.deepEqual(home.problems, [])

  const runs = new RunService({ pool } as unknown as ExecutorDeps)
  await assert.rejects(runs.start("home_broken"), /is a draft/)
  await assert.rejects(runs.start("no_such_integration"), /Unknown integration/)
  const queued = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = 'home_broken' AND status = 'queued'")
  assert.equal(queued.rows[0].n, 0)
  await pool.query("UPDATE app.integrations SET status = 'ready' WHERE id = 'home_broken'")
})

test("the title comes from settings and falls back to the product name", async () => {
  assert.equal((await getHomeSummary(pool, null, NO_AI)).title, DEFAULT_SITE_TITLE)
  await setSetting(pool, SITE_TITLE_KEY, "Data Integrator Madagascar")
  assert.equal((await getHomeSummary(pool, null, NO_AI)).title, "Data Integrator Madagascar")
  // Clearing the setting restores the default rather than blanking the heading
  await setSetting(pool, SITE_TITLE_KEY, null)
  assert.equal((await getHomeSummary(pool, null, NO_AI)).title, DEFAULT_SITE_TITLE)
})

test("parseSiteTitle trims, caps length, and treats blank as unset", () => {
  assert.equal(parseSiteTitle({ title: "  Data Integrator Madagascar  " }), "Data Integrator Madagascar")
  assert.equal(parseSiteTitle({ title: "   " }), null)
  assert.equal(parseSiteTitle({}), null)
  assert.equal(parseSiteTitle({ title: "x".repeat(200) })?.length, 120)
  assert.throws(() => parseSiteTitle({ title: 7 }), /title must be a string/)
})

test("integrations declaring unset secrets are listed as needing credentials, with their paused session", async () => {
  await installIntegration(pool, {
    ...BROKEN,
    id: "home_secret",
    secrets: ["api_key", "TOKEN"],
    destinations: [
      { kind: "table", tableId: "home_secret_rows", action: "append", columns: [{ id: "site", type: "text" }] }
    ]
  })
  let home = await getHomeSummary(pool, null, NO_AI)
  const need = home.credentialsNeeded.find(n => n.id === "home_secret")
  assert.ok(need)
  assert.deepEqual(need.missing, ["api_key", "TOKEN"])
  assert.equal(need.sessionId, null)

  const session = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, client_state) VALUES ('designer', 'paused', $1) RETURNING id`,
    [JSON.stringify({ definition: { id: "home_secret" } })]
  )
  home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.credentialsNeeded.find(n => n.id === "home_secret")?.sessionId, session.rows[0].id)

  await pool.query(
    "INSERT INTO app.integration_secrets (integration_id, name, value) VALUES ('home_secret', 'api_key', '\\x00')"
  )
  home = await getHomeSummary(pool, null, NO_AI)
  assert.deepEqual(home.credentialsNeeded.find(n => n.id === "home_secret")?.missing, ["TOKEN"])
  await pool.query("UPDATE app.integrations SET enabled = false WHERE id = 'home_secret'")
  home = await getHomeSummary(pool, null, NO_AI)
  assert.equal(home.credentialsNeeded.find(n => n.id === "home_secret"), undefined)
})

test("validateDefinition: secret names are checked", () => {
  const base = { ...BROKEN, id: "home_valid" }
  validateDefinition({ ...base, secrets: ["api_key", "TOKEN_2"] })
  assert.throws(() => validateDefinition({ ...base, secrets: ["9bad"] }), /Invalid secret name/)
  assert.throws(() => validateDefinition({ ...base, secrets: ["a", "a"] }), /declared twice/)
  assert.throws(() => validateDefinition({ ...base, secrets: "a" as unknown as string[] }), /array of names/)
})

test("quality: flagged latest success and overdue cadence show; healthy ones do not", async () => {
  const daily = (id: string, tableId: string): IntegrationDefinition => ({
    ...LOADER,
    id,
    destinations: [{ kind: "table", tableId, action: "append", columns: [{ id: "site", type: "text" }] }],
    validation: { expectedCadence: "P1D" }
  })
  await installIntegration(pool, daily("home_fresh", "home_fresh_rows"))
  await installIntegration(pool, daily("home_overdue", "home_overdue_rows"))
  await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status, finished_at) VALUES
       ('home_fresh', 'cron', 'succeeded', now() - interval '20 hours'),
       ('home_overdue', 'cron', 'succeeded', now() - interval '3 days'),
       ('home_loader', 'cron', 'succeeded', now())`
  )
  await pool.query(
    `UPDATE app.runs SET flags = $1 WHERE integration_id = 'home_loader' AND finished_at = (SELECT max(finished_at) FROM app.runs WHERE integration_id = 'home_loader')`,
    [JSON.stringify([{ destinationId: "home_rows", field: "site", rule: "enum", count: 2, message: "home_rows.site: 2 values not in the column's codes" }])]
  )
  const home = await getHomeSummary(pool, null, NO_AI)
  const byId = new Map(home.quality.map(q => [q.id, q]))
  assert.equal(byId.get("home_overdue")?.kind, "stale")
  assert.equal(byId.get("home_loader")?.kind, "flagged")
  assert.deepEqual(byId.get("home_loader")?.messages, ["home_rows.site: 2 values not in the column's codes"])
  assert.equal(byId.has("home_fresh"), false)
})

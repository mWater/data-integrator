import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { enqueueDueRuns } from "../src/scheduler.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** A definition firing every minute. */
function definition(id: string, cron: string | null): IntegrationDefinition {
  return {
    id,
    name: { _base: "en", en: id },
    trigger: cron ? { cron } : {},
    runtime: "node",
    destinations: [{ kind: "table", tableId: `${id}_rows`, action: "replace", columns: [{ id: "v", type: "text" }] }],
    code: "export default async function run() { return {} }",
    contract: 2
  } as IntegrationDefinition
}

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

test("enqueueDueRuns: due integrations enqueue once; paused, draft, due-later, and manual do not", async () => {
  await installIntegration(pool, definition("sched_due", "* * * * *"))
  await installIntegration(pool, definition("sched_later", "0 6 5 1 *"))
  await installIntegration(pool, definition("sched_manual", null))
  await installIntegration(pool, definition("sched_paused", "* * * * *"))
  await pool.query("UPDATE app.integrations SET enabled = false WHERE id = 'sched_paused'")
  await installIntegration(pool, definition("sched_draft", "* * * * *"), "draft")

  const now = new Date("2026-08-10T12:30:00Z")
  assert.equal(await enqueueDueRuns({ pool }, now), 1)

  const queued = await pool.query(
    "SELECT integration_id, trigger FROM app.runs WHERE status = 'queued' ORDER BY integration_id"
  )
  assert.deepEqual(queued.rows, [{ integration_id: "sched_due", trigger: "cron" }])

  // Same minute again: the one-queued index dedups
  assert.equal(await enqueueDueRuns({ pool }, now), 0)

  // A queued (or running) run also blocks the next minute's enqueue until it drains
  assert.equal(await enqueueDueRuns({ pool }, new Date("2026-08-10T12:31:00Z")), 0)

  // Once the run finishes, the next minute enqueues again
  await pool.query("UPDATE app.runs SET status = 'succeeded', finished_at = now() WHERE integration_id = 'sched_due'")
  assert.equal(await enqueueDueRuns({ pool }, new Date("2026-08-10T12:32:00Z")), 1)
})

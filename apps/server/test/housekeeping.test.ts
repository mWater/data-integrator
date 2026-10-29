import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { createUser } from "../src/auth.js"
import { RasterStore } from "../src/rasterStore.js"
import { draftSchema } from "../src/scratch.js"
import { sweepHousekeeping } from "../src/housekeeping.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** Webhook integration whose events the sweep trims. */
const HOOKED: IntegrationDefinition = {
  id: "kept_tidy",
  name: { _base: "en", en: "Kept tidy" },
  trigger: { webhook: true },
  runtime: "python",
  destinations: [{ kind: "table", tableId: "tidy_rows", action: "append", columns: [{ id: "site", type: "text" }] }],
  code: "def run(ctx): ...",
  contract: 2
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

test("housekeeping trims what only grows and keeps what is live", async () => {
  const user = await createUser(pool, "tidy@example.org", "hunter2hunter2", "editor")
  await pool.query(
    `INSERT INTO app.auth_sessions (token_hash, user_id, expires_at) VALUES ('old', $1, now() - interval '1 day'), ('live', $1, now() + interval '1 day')`,
    [user.id]
  )

  await installIntegration(pool, HOOKED)
  const runs = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status, finished_at, log) VALUES
       ('kept_tidy', 'webhook', 'succeeded', now() - interval '100 days', 'old log'),
       ('kept_tidy', 'webhook', 'succeeded', now() - interval '1 day', 'recent log')
     RETURNING id`
  )
  const [oldRun, newRun] = runs.rows.map(r => r.id as string)
  await pool.query(
    `INSERT INTO app.webhook_events (integration_id, payload, received_at, run_id) VALUES
       ('kept_tidy', '{}', now() - interval '40 days', $1),
       ('kept_tidy', '{}', now() - interval '1 day', $2),
       ('kept_tidy', '{}', now() - interval '40 days', NULL)`,
    [oldRun, newRun]
  )

  const idle = await pool.query(
    `INSERT INTO app.agent_sessions (kind, user_id, status, messages, client_state, usage, updated_at)
     VALUES ('designer', $1, 'paused', '[]', '{}', '{}', now() - interval '40 days') RETURNING id`,
    [user.id]
  )
  const idleId = idle.rows[0].id as string
  await pool.query(`CREATE SCHEMA ${draftSchema(idleId)}`)

  const store = new RasterStore(await mkdtemp(path.join(tmpdir(), "housekeeping-store-")))
  const orphan = path.join(store.root, "some_layer", "0b7c6f39-0a1e-4c2a-9d55-3f6f0f2e9c11")
  const fresh = path.join(store.root, "some_layer", "6a3d1e0e-5b6c-4f0e-8f4f-2b1f5b0d7e22")
  for (const dir of [orphan, fresh]) {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "0.tif"), "x")
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
  await utimes(orphan, twoDaysAgo, twoDaysAgo)

  const result = await sweepHousekeeping(pool, store, await mkdtemp(path.join(tmpdir(), "housekeeping-work-")))
  assert.deepEqual(result, { inactiveAccounts: 0, authSessions: 1, webhookEvents: 1, runLogs: 1, scratchSessions: 1, orphanSnapshots: 1, leftoverJobTmp: 0 })

  assert.deepEqual((await pool.query("SELECT token_hash FROM app.auth_sessions")).rows.map(r => r.token_hash), ["live"])
  // Unconsumed events wait for their run however old they are
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.webhook_events")).rows[0].n, 2)
  const logs = await pool.query("SELECT id, log FROM app.runs ORDER BY finished_at")
  assert.deepEqual(logs.rows.map(r => r.log), [null, "recent log"])
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [draftSchema(idleId)])).rowCount, 0)
  // A store directory younger than a day may belong to a run still committing
  assert.deepEqual(await readdir(path.join(store.root, "some_layer")), [path.basename(fresh)])

  // A second sweep finds nothing left to do
  assert.deepEqual(await sweepHousekeeping(pool, store, store.root), {
    inactiveAccounts: 0, authSessions: 0, webhookEvents: 0, runLogs: 0, scratchSessions: 0, orphanSnapshots: 0, leftoverJobTmp: 0
  })
})

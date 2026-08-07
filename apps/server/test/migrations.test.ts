import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
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
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool.end()
  await db.stop()
})

test("applies all migrations, then is idempotent", { skip: !AVAILABLE }, async () => {
  const first = await migrate(pool, MIGRATIONS_DIR)
  assert.ok(first.includes("0001_app_schema.sql"))
  const second = await migrate(pool, MIGRATIONS_DIR)
  assert.deepEqual(second, [])
})

test("expected tables exist in app schema", { skip: !AVAILABLE }, async () => {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name`
  )
  const tables = result.rows.map(r => r.table_name)
  for (const expected of [
    "migrations", "integrations", "runs", "webhook_events",
    "raster_layers", "raster_snapshots", "agent_sessions",
    "users", "secrets", "dashboards", "dashboard_versions"
  ]) {
    assert.ok(tables.includes(expected), `missing app.${expected}`)
  }
})

test("insert round-trip: integration, run, layer, snapshot, promotion", { skip: !AVAILABLE }, async () => {
  await pool.query(
    `INSERT INTO app.integrations (id, definition, definition_hash) VALUES ('test-int', '{}', 'h1')`
  )
  const run = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status) VALUES ('test-int', 'manual', 'succeeded') RETURNING id`
  )
  await pool.query(
    `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
     VALUES ('test-layer', 'test-int', 'Test', 'time-series', '[]')`
  )
  const snapshot = await pool.query(
    `INSERT INTO app.raster_snapshots (layer_id, "timestamp", footprint, path, bands, run_id)
     VALUES ('test-layer', now(), ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326),
             'test-layer/s1.tif', '["pop"]', $1)
     RETURNING id`,
    [run.rows[0].id]
  )
  // Promotion: flip status and current pointer in one transaction
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`UPDATE app.raster_snapshots SET status = 'promoted' WHERE id = $1`, [snapshot.rows[0].id])
    await client.query(`UPDATE app.raster_layers SET current_snapshot_id = $1 WHERE id = 'test-layer'`, [snapshot.rows[0].id])
    await client.query("COMMIT")
  } finally {
    client.release()
  }
  const layer = await pool.query(`SELECT current_snapshot_id FROM app.raster_layers WHERE id = 'test-layer'`)
  assert.equal(layer.rows[0].current_snapshot_id, snapshot.rows[0].id)
})

test("check constraints reject invalid enum values", { skip: !AVAILABLE }, async () => {
  await assert.rejects(
    pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('test-int', 'bogus', 'queued')`),
    /check/i
  )
})

test("emails are unique case-insensitively", { skip: !AVAILABLE }, async () => {
  await pool.query(
    `INSERT INTO app.users (email, password_hash, role) VALUES ('Admin@Example.org', 'x', 'admin')`
  )
  await assert.rejects(
    pool.query(`INSERT INTO app.users (email, password_hash, role) VALUES ('admin@example.org', 'x', 'viewer')`),
    /duplicate key/
  )
})

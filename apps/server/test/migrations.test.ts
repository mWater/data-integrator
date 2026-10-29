import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
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
    "migrations", "integration_versions", "integrations", "runs", "webhook_events",
    "raster_layers", "raster_snapshots", "data_tables", "agent_sessions",
    "users", "auth_sessions", "integration_secrets", "settings", "dashboards", "dashboard_versions",
    "raster_sources"
  ]) {
    assert.ok(tables.includes(expected), `missing app.${expected}`)
  }
})

/** Integration row plus its v1 archive row, committed together to satisfy the deferred FK. */
async function insertIntegration(id: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO app.integrations (id, definition, version) VALUES ($1, '{}', 1)`, [id])
    await client.query(
      `INSERT INTO app.integration_versions (integration_id, version, definition) VALUES ($1, 1, '{}')`,
      [id]
    )
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

test("insert round-trip: integration, run, layer, snapshot, promotion", { skip: !AVAILABLE }, async () => {
  await insertIntegration("test-int")
  const run = await pool.query(
    `INSERT INTO app.runs (integration_id, trigger, status) VALUES ('test-int', 'manual', 'succeeded') RETURNING id`
  )
  await pool.query(
    `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
     VALUES ('test-layer', 'test-int', '{"_base": "en", "en": "Test"}', 'time-series', '[]')`
  )
  const snapshot = await pool.query(
    `INSERT INTO app.raster_snapshots (layer_id, observed_at, footprint, bands, run_id, status)
     VALUES ('test-layer', now(), ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326), '["pop"]', $1, 'promoted')
     RETURNING id`,
    [run.rows[0].id]
  )
  await pool.query(
    `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint)
     VALUES ($1, 0, 'test-layer/s1.tif', ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326))`,
    [snapshot.rows[0].id]
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

test("integrations.version cannot dangle", { skip: !AVAILABLE }, async () => {
  await assert.rejects(
    pool.query(`INSERT INTO app.integrations (id, definition, version) VALUES ('dangling-int', '{}', 1)`),
    /foreign key/
  )
  await assert.rejects(
    pool.query(`UPDATE app.runs SET definition_version = 99 WHERE integration_id = 'test-int'`),
    /foreign key/
  )
})

test("at most one running and one queued run per integration", { skip: !AVAILABLE }, async () => {
  await insertIntegration("ser-int")
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('ser-int', 'cron', 'running')`)
  await assert.rejects(
    pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('ser-int', 'manual', 'running')`),
    /duplicate key/
  )
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('ser-int', 'cron', 'queued')`)
  await assert.rejects(
    pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('ser-int', 'cron', 'queued')`),
    /duplicate key/
  )
})

test("data_tables enforces one writer per table", { skip: !AVAILABLE }, async () => {
  await pool.query(
    `INSERT INTO app.data_tables (id, integration_id, spec) VALUES ('water_points', 'test-int', '{}')`
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO app.data_tables (id, integration_id, spec) VALUES ('water_points', 'ser-int', '{}')`
    ),
    /duplicate key/
  )
})

test("dashboards.current_version cannot dangle", { skip: !AVAILABLE }, async () => {
  await pool.query(`INSERT INTO app.dashboards (id, name) VALUES ('dash', 'Dash')`)
  await assert.rejects(
    pool.query(`UPDATE app.dashboards SET current_version = 1 WHERE id = 'dash'`),
    /foreign key/
  )
  await pool.query(
    `INSERT INTO app.dashboard_versions (dashboard_id, version, source, queries, kit_version, bundle_js, bundle_css)
     VALUES ('dash', 1, '', '[]', 'v1', '', '')`
  )
  await pool.query(`UPDATE app.dashboards SET current_version = 1 WHERE id = 'dash'`)
})

test("install versioning: bump on change, no-op on re-install, created_by recorded", { skip: !AVAILABLE }, async () => {
  const definition: IntegrationDefinition = {
    id: "ver_int",
    name: { _base: "en", en: "Versioning" },
    trigger: {},
    runtime: "node",
    destinations: [
      { kind: "table", tableId: "ver_rows", action: "replace", columns: [{ id: "name", type: "text" }] }
    ],
    code: "export default async function run() { return {} }",
    contract: 2
  }
  const user = await pool.query(
    `INSERT INTO app.users (email, password_hash, role) VALUES ('installer@example.org', 'x', 'editor') RETURNING id`
  )
  const userId = user.rows[0].id as string

  assert.deepEqual(await installIntegration(pool, definition, "ready", userId), { version: 1 })
  // Re-installing the same definition is a no-op, not a new version
  assert.deepEqual(await installIntegration(pool, definition), { version: 1 })
  assert.deepEqual(await installIntegration(pool, { ...definition, name: { _base: "en", en: "Versioning 2" } }), { version: 2 })

  const versions = await pool.query(
    `SELECT version, created_by, definition->'name'->>'en' AS name FROM app.integration_versions
     WHERE integration_id = 'ver_int' ORDER BY version`
  )
  assert.deepEqual(versions.rows, [
    { version: 1, created_by: userId, name: "Versioning" },
    { version: 2, created_by: null, name: "Versioning 2" }
  ])
  assert.equal((await pool.query(`SELECT version FROM app.integrations WHERE id = 'ver_int'`)).rows[0].version, 2)
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

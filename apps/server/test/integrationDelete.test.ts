import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, mkdir, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { deleteIntegration, installIntegration, integrationUsage } from "../src/install.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool
let store: RasterStore

/** Source integration: one table, one raster layer. */
const SOURCE: IntegrationDefinition = {
  id: "del_source",
  name: { _base: "en", en: "Delete source" },
  trigger: {},
  runtime: "python",
  destinations: [
    {
      kind: "table",
      tableId: "del_rows",
      action: "append",
      columns: [{ id: "site", type: "text" }]
    },
    { kind: "raster", layerId: "del_layer", temporality: "time-series", bands: [{ id: "v" }] }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

/** Derived integration reading the source's table. */
const DERIVED: IntegrationDefinition = {
  id: "del_derived",
  name: { _base: "en", en: "Delete derived" },
  trigger: {},
  runtime: "python",
  inputs: { src: { kind: "table", tableId: "del_rows" } },
  destinations: [
    {
      kind: "table",
      tableId: "del_derived_rows",
      action: "replace",
      columns: [{ id: "n", type: "integer" }]
    }
  ],
  code: "def run(ctx): ...",
  contract: 2
}

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  store = new RasterStore(await mkdtemp(path.join(tmpdir(), "del-store-")))

  await installIntegration(pool, SOURCE)
  await installIntegration(pool, DERIVED)

  // A run with rows, a promoted snapshot with a store file, a webhook event, a session
  const run = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('del_source', 'manual', 'succeeded') RETURNING id"
  )
  await pool.query("INSERT INTO data.del_rows (site, _run_id) VALUES ('a', $1), ('b', $1)", [run.rows[0].id])
  await mkdir(path.dirname(store.absolute("del_layer/snap.tif")), { recursive: true })
  await writeFile(store.absolute("del_layer/snap.tif"), "tif")
  await pool.query(
    `INSERT INTO app.raster_snapshots (id, layer_id, observed_at, footprint, crs, bands, run_id, status)
     VALUES ('22222222-2222-2222-2222-222222222222', 'del_layer', '2026-08-01T00:00:00Z',
             ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326),
             'EPSG:4326', '["v"]', $1, 'promoted')`,
    [run.rows[0].id]
  )
  await pool.query(
    `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint)
     VALUES ('22222222-2222-2222-2222-222222222222', 0, 'del_layer/snap.tif',
             ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326))`
  )
  await pool.query("UPDATE app.raster_layers SET current_snapshot_id = '22222222-2222-2222-2222-222222222222' WHERE id = 'del_layer'")
  await pool.query("INSERT INTO app.webhook_events (integration_id, payload) VALUES ('del_source', '{}')")
  await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, client_state, usage) VALUES ('designer', 'paused', '{"definition": {"id": "del_source"}}', '{}')`
  )
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool?.end()
  await db?.stop()
})

test("usage reports owned data and dependents", { skip: !AVAILABLE }, async () => {
  const usage = await integrationUsage(pool, "del_source")
  assert.deepEqual(usage.tables, ["del_rows"])
  assert.deepEqual(usage.layers, ["del_layer"])
  assert.deepEqual(usage.dependents, [{ id: "del_derived", via: "del_rows" }])
  assert.equal(usage.runs, 1)
})

test("delete refuses while a dependent integration reads its data", { skip: !AVAILABLE }, async () => {
  await assert.rejects(deleteIntegration(pool, "del_source"), /dependency of: del_derived \(reads del_rows\)/)
  // Nothing was harmed
  const rows = await pool.query("SELECT count(*)::int AS n FROM data.del_rows")
  assert.equal(rows.rows[0].n, 2)
})

test("delete refuses while a run is queued", { skip: !AVAILABLE }, async () => {
  await pool.query("INSERT INTO app.runs (integration_id, trigger, status) VALUES ('del_derived', 'manual', 'queued')")
  await assert.rejects(deleteIntegration(pool, "del_derived"), /queued or running/)
  await pool.query("DELETE FROM app.runs WHERE integration_id = 'del_derived' AND status = 'queued'")
})

test("delete removes everything owned and frees the names", { skip: !AVAILABLE }, async () => {
  // Dependent goes first, then the source is deletable
  const derived = await deleteIntegration(pool, "del_derived")
  assert.equal(derived.ok, true)
  assert.equal(derived.tables, 1)

  const result = await deleteIntegration(pool, "del_source")
  assert.equal(result.ok, true)
  assert.equal(result.tables, 1)
  assert.equal(result.snapshots, 1)
  assert.deepEqual(result.snapshotPaths, ["del_layer/snap.tif"])
  assert.deepEqual(result.layerIds, ["del_layer"])
  assert.equal(result.runs, 1)
  assert.equal(result.sessions, 1)

  // Table dropped, registry freed, layers and snapshots gone, integration gone
  const table = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'data' AND table_name = 'del_rows'"
  )
  assert.equal(table.rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.data_tables WHERE id = 'del_rows'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.raster_layers WHERE id = 'del_layer'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.raster_snapshots WHERE layer_id = 'del_layer'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'del_source'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.integration_versions WHERE integration_id = 'del_source'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.runs WHERE integration_id = 'del_source'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.webhook_events WHERE integration_id = 'del_source'")).rows.length, 0)

  // The design transcript survives, unbound
  const session = await pool.query("SELECT client_state FROM app.agent_sessions WHERE kind = 'designer'")
  assert.equal(session.rows.length, 1)
  assert.equal(session.rows[0].client_state.definition.id, "")

  // The caller cleans up files from the returned paths (route behavior);
  // the store file is untouched by the DB-side delete
  await access(store.absolute("del_layer/snap.tif"))

  // Freed names are claimable by a new integration
  await installIntegration(pool, { ...SOURCE, id: "del_reclaimer", name: { _base: "en", en: "Reclaimer" } })
  const owner = await pool.query("SELECT integration_id FROM app.data_tables WHERE id = 'del_rows'")
  assert.equal(owner.rows[0].integration_id, "del_reclaimer")
})

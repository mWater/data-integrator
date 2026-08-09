import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { Runner } from "@data-integrator/runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { claimNextRun, executeRun, ExecutorDeps } from "../src/executor.js"
import { cleanupScratch, draftSchema, scratchLayerId } from "../src/scratch.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const PY_IMAGE = "localhost/integrator-runtime-python:dev"

async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args)
    return true
  } catch {
    return false
  }
}

const PODMAN = await ok("podman", ["--version"])
const RUNSC = await access("/usr/local/bin/runsc").then(() => true, () => false)
const HAS_IMAGE = PODMAN && (await ok("podman", ["image", "exists", PY_IMAGE]))
const AVAILABLE = PODMAN && RUNSC && HAS_IMAGE

/** End-to-end definition: rows into a merge table plus one COG snapshot per run. */
const DEFINITION: IntegrationDefinition = {
  id: "e2e_test",
  name: "E2E test",
  trigger: { cron: "0 0 * * *" },
  runtime: "python3.12",
  destinations: [
    {
      kind: "table",
      tableId: "e2e_rows",
      action: "merge",
      mergeColumns: ["site"],
      columns: [
        { id: "site", type: "text" },
        { id: "value", type: "number" }
      ]
    },
    {
      kind: "raster",
      layerId: "e2e_layer",
      temporality: "time-series",
      bands: [{ id: "v", units: "m" }]
    }
  ],
  code: `
import numpy as np
import rasterio
from rasterio.transform import from_origin

def run(ctx):
    cursor = ((ctx.previous_state or {}).get("cursor") or 0) + 1
    data = (np.ones((32, 32)) * cursor).astype("float32")
    with rasterio.open(
        f"{ctx.out_dir}/snap.tif", "w", driver="GTiff",
        width=32, height=32, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_origin(44, -18, 0.01, 0.01),
    ) as dst:
        dst.write(data, 1)
    return {
        "data": {"e2e_rows": [
            {"site": "a", "value": cursor * 1.5},
            {"site": f"new_{cursor}", "value": 0.0},
        ]},
        "rasters": [{
            "layerId": "e2e_layer",
            "path": "snap.tif",
            "timestamp": f"2026-0{cursor}-01T00:00:00Z",
            "footprint": [44.0, -18.32, 44.32, -18.0],
            "crs": "EPSG:4326",
        }],
        "state": {"cursor": cursor},
    }
`,
  contract: 2
}

let db: TestDb
let pool: pg.Pool
let deps: ExecutorDeps
const runner = new Runner({ network: "integrator-jobs-exec", egress: "open" })

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  await runner.ensureReady()
  deps = {
    pool,
    runner,
    store: new RasterStore(await mkdtemp(path.join(tmpdir(), "raster-store-"))),
    workRoot: await mkdtemp(path.join(tmpdir(), "work-root-")),
    secretKey: null,
    images: { "python3.12": PY_IMAGE },
    databaseUrl: db.url
  }
}, { timeout: 180_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool.end()
  await db.stop()
  await runner.teardown()
})

async function runOnce(): Promise<string> {
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_test', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run, "claimed a run")
  await executeRun(deps, run!)
  return run!.id
}

test("first run: rows, snapshot, state, stats", { skip: !AVAILABLE }, async () => {
  await installIntegration(pool, DEFINITION)
  const runId = await runOnce()
  const run = await pool.query("SELECT status, state_out, stats, definition_version, error FROM app.runs WHERE id = $1", [runId])
  assert.equal(run.rows[0].status, "succeeded", run.rows[0].error ?? "")
  assert.deepEqual(run.rows[0].state_out, { cursor: 1 })
  assert.equal(run.rows[0].stats.rows.e2e_rows, 2)
  assert.equal(run.rows[0].definition_version, 1)

  const rows = await pool.query("SELECT site, value, _run_id FROM data.e2e_rows ORDER BY site")
  assert.equal(rows.rows.length, 2)
  assert.ok(rows.rows.every(r => r._run_id === runId))

  const snapshot = await pool.query(
    `SELECT s.status, s.crs, s.path, l.current_snapshot_id = s.id AS is_current
     FROM app.raster_snapshots s JOIN app.raster_layers l ON l.id = s.layer_id`
  )
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.rows[0].status, "promoted")
  assert.equal(snapshot.rows[0].crs, "EPSG:4326")
  assert.ok(snapshot.rows[0].is_current)
  await access(deps.store.absolute(snapshot.rows[0].path))
}, { timeout: 180_000 })

test("second run: state chains, merge updates, current pointer advances", { skip: !AVAILABLE }, async () => {
  await runOnce()
  const state = await pool.query(
    `SELECT state_out FROM app.runs WHERE integration_id = 'e2e_test' AND status = 'succeeded'
     ORDER BY finished_at DESC LIMIT 1`
  )
  assert.deepEqual(state.rows[0].state_out, { cursor: 2 })

  const rows = await pool.query("SELECT site, value FROM data.e2e_rows ORDER BY site")
  assert.equal(rows.rows.length, 3) // a (updated), new_1, new_2
  assert.equal(rows.rows.find(r => r.site === "a")!.value, 3.0)

  const layer = await pool.query(
    `SELECT (SELECT count(*)::int FROM app.raster_snapshots WHERE status = 'promoted') AS promoted,
            (SELECT observed_at FROM app.raster_snapshots s JOIN app.raster_layers l ON l.current_snapshot_id = s.id) AS current_time`
  )
  assert.equal(layer.rows[0].promoted, 2) // time-series keeps history
  assert.equal(new Date(layer.rows[0].current_time).getUTCMonth(), 1) // Feb = cursor 2
}, { timeout: 180_000 })

test("failing code marks the run failed with the traceback", { skip: !AVAILABLE }, async () => {
  const broken: IntegrationDefinition = {
    ...DEFINITION,
    id: "e2e_broken",
    destinations: [
      {
        kind: "table",
        tableId: "e2e_broken_rows",
        action: "append",
        columns: [{ id: "site", type: "text" }]
      }
    ],
    code: `def run(ctx):\n    raise RuntimeError("kaboom")`
  }
  await installIntegration(pool, broken)
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_broken', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  await executeRun(deps, run!)
  const result = await pool.query("SELECT status, error FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(result.rows[0].status, "failed")
  assert.match(result.rows[0].error, /kaboom/)
}, { timeout: 180_000 })

test("derived integration: /in materialization and lineage", { skip: !AVAILABLE }, async () => {
  const derived: IntegrationDefinition = {
    id: "e2e_derived",
    name: "Derived",
    trigger: {},
    runtime: "python3.12",
    inputs: {
      src: { kind: "table", tableId: "e2e_rows", format: "json" },
      snaps: { kind: "raster", layerId: "e2e_layer", select: { latest: 2 } }
    },
    destinations: [
      {
        kind: "table",
        tableId: "e2e_derived_rows",
        action: "replace",
        columns: [
          { id: "src_rows", type: "integer" },
          { id: "snap_files", type: "integer" }
        ]
      }
    ],
    code: `
import json, os

def run(ctx):
    manifest = json.load(open(f"{ctx.in_dir}/manifest.json"))
    src = manifest["inputs"]["src"]
    rows = json.load(open(f"{ctx.in_dir}/{src['path']}"))
    snaps = manifest["inputs"]["snaps"]["snapshots"]
    for s in snaps:
        assert os.path.exists(f"{ctx.in_dir}/{s['path']}"), s["path"]
    return {"data": {"e2e_derived_rows": [{"src_rows": len(rows), "snap_files": len(snaps)}]}}
`,
    contract: 2
  }
  await installIntegration(pool, derived)
  const srcCount = Number((await pool.query("SELECT count(*) AS n FROM data.e2e_rows")).rows[0].n)

  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_derived', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  await executeRun(deps, run!)

  const final = await pool.query("SELECT status, error, inputs FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(final.rows[0].status, "succeeded", final.rows[0].error ?? "")
  // Lineage: the run records exactly which snapshots and extracts fed it
  assert.equal(final.rows[0].inputs.inputs.snaps.snapshots.length, 2)
  assert.equal(final.rows[0].inputs.inputs.src.rowCount, srcCount)

  const out = await pool.query("SELECT src_rows, snap_files FROM data.e2e_derived_rows")
  assert.equal(Number(out.rows[0].src_rows), srcCount)
  assert.equal(Number(out.rows[0].snap_files), 2)
}, { timeout: 180_000 })

test("scratch run: session schema, preview layer, no install, cleanup", { skip: !AVAILABLE }, async () => {
  const session = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, messages, client_state, usage)
     VALUES ('designer', 'active', '[]', '{}', '{}') RETURNING id`
  )
  const sessionId = session.rows[0].id as string
  const scratchDef: IntegrationDefinition = { ...DEFINITION, id: "e2e_scratch" }

  const inserted = await pool.query(
    `INSERT INTO app.runs (session_id, trigger, status) VALUES ($1, 'agent', 'queued') RETURNING id`,
    [sessionId]
  )
  const runId = inserted.rows[0].id as string
  // Workers never claim session runs; only the designer executes them
  assert.equal(await claimNextRun(pool, "test-worker"), null)
  await pool.query(
    `UPDATE app.runs SET status = 'running', claimed_by = 'designer', heartbeat_at = now(), started_at = now() WHERE id = $1`,
    [runId]
  )
  await executeRun(
    deps,
    { id: runId, integration_id: null, params: null },
    { scratch: { sessionId, definition: scratchDef } }
  )

  const run = await pool.query("SELECT status, error, definition_version FROM app.runs WHERE id = $1", [runId])
  assert.equal(run.rows[0].status, "succeeded", run.rows[0].error ?? "")
  assert.equal(run.rows[0].definition_version, null)

  // Nothing was installed; rows landed in the session's draft schema
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'e2e_scratch'")).rows.length, 0)
  const schema = draftSchema(sessionId)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.e2e_rows`)).rows[0].n, 2)

  // The preview layer is session-owned under a scratch id, coexisting with the real e2e_layer
  const layers = await pool.query("SELECT id FROM app.raster_layers WHERE session_id = $1", [sessionId])
  assert.equal(layers.rows.length, 1)
  assert.equal(layers.rows[0].id, scratchLayerId(sessionId, "e2e_layer"))
  const snapshot = await pool.query("SELECT path FROM app.raster_snapshots WHERE layer_id = $1", [layers.rows[0].id])
  assert.equal(snapshot.rows.length, 1)
  await access(deps.store.absolute(snapshot.rows[0].path))

  await cleanupScratch(pool, deps.store, deps.workRoot, sessionId)
  assert.equal(
    (await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema])).rows.length,
    0
  )
  assert.equal((await pool.query("SELECT 1 FROM app.raster_layers WHERE session_id = $1", [sessionId])).rows.length, 0)
  await assert.rejects(() => access(deps.store.absolute(snapshot.rows[0].path)))
}, { timeout: 180_000 })

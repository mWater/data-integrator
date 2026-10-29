import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, chmod, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { Runner } from "@mwater/integration-runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { claimNextRun, executeRun, ExecutorDeps } from "../src/executor.js"
import { cleanupScratch, draftSchema, scratchLayerId } from "../src/scratch.js"
import { JOB_TMP_DIR } from "../src/jobTmp.js"
import { RasterStore } from "../src/rasterStore.js"
import { setSecret } from "../src/secrets.js"
import { randomBytes } from "node:crypto"
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
  name: { _base: "en", en: "E2E test" },
  trigger: { cron: "0 0 * * *" },
  runtime: "python",
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
const runner = new Runner({ network: "integrator-jobs-exec", egress: "open", diskMonitorMs: 1000 })

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  // Session out-db GUCs: the migration's ALTER DATABASE misses connections
  // the pool opened before it ran, and assertions read out-db pixels
  pool = new pg.Pool({
    connectionString: db.url,
    max: 5,
    options: "-c postgis.enable_outdb_rasters=on -c postgis.gdal_enabled_drivers=ENABLE_ALL"
  })
  await migrate(pool, MIGRATIONS_DIR)
  await runner.ensureReady()
  // mkdtemp is 0700; the test database's postgres user must traverse it
  const storeRoot = await mkdtemp(path.join(tmpdir(), "raster-store-"))
  await chmod(storeRoot, 0o755)
  deps = {
    pool,
    runner,
    store: new RasterStore(storeRoot),
    workRoot: await mkdtemp(path.join(tmpdir(), "work-root-")),
    secretKey: null,
    images: { "python": PY_IMAGE },
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
  const run = await pool.query(
    "SELECT status, state_out, stats, definition_version, inputs, error FROM app.runs WHERE id = $1",
    [runId]
  )
  assert.equal(run.rows[0].status, "succeeded", run.rows[0].error ?? "")
  assert.deepEqual(run.rows[0].state_out, { cursor: 1 })
  assert.equal(run.rows[0].stats.rows.e2e_rows, 2)
  assert.equal(run.rows[0].definition_version, 1)
  // No definition AOI and no deployment default: lineage records full extent
  assert.equal(run.rows[0].inputs.aoi, null)

  const rows = await pool.query("SELECT site, value, _run_id FROM data.e2e_rows ORDER BY site")
  assert.equal(rows.rows.length, 2)
  assert.ok(rows.rows.every(r => r._run_id === runId))

  const snapshot = await pool.query(
    `SELECT s.status, s.crs, src.path, l.current_snapshot_id = s.id AS is_current
     FROM app.raster_snapshots s JOIN app.raster_layers l ON l.id = s.layer_id
     JOIN app.raster_sources src ON src.snapshot_id = s.id`
  )
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.rows[0].status, "promoted")
  assert.equal(snapshot.rows[0].crs, "EPSG:4326")
  assert.ok(snapshot.rows[0].is_current)
  await access(deps.store.absolute(snapshot.rows[0].path))

  // Registered out-db in the same transaction: pixel values queryable in SQL
  const raster = await pool.query(
    `SELECT ST_Value(rast, 1, ST_SetSRID(ST_MakePoint(44.15, -18.15), 4326)) AS v FROM data.rasters`
  )
  assert.equal(raster.rows.length, 1)
  assert.equal(Number(raster.rows[0].v), 1)
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

  const registered = await pool.query("SELECT count(*)::int AS n FROM data.rasters")
  assert.equal(registered.rows[0].n, 2)
}, { timeout: 180_000 })

test("settings reach ctx.params resolved; a rebuild starts from no state and an empty /work", { skip: !AVAILABLE }, async () => {
  const definition: IntegrationDefinition = {
    id: "e2e_settings",
    name: { _base: "en", en: "Settings test" },
    trigger: {},
    runtime: "python",
    settings: {
      months_back: { label: { _base: "en", en: "Months" }, type: "integer", default: 12, min: 1, max: 120, appliesOn: "rebuild" },
      variant: {
        label: { _base: "en", en: "Variant" },
        type: "choice",
        default: "full",
        choices: [
          { value: "full", label: { _base: "en", en: "Full" } },
          { value: "simplified", label: { _base: "en", en: "Simplified" } }
        ]
      }
    },
    settingValues: { variant: "simplified" },
    destinations: [
      {
        kind: "table",
        tableId: "e2e_settings_seen",
        action: "append",
        columns: [
          { id: "had_state", type: "boolean" },
          { id: "had_work", type: "boolean" },
          { id: "params", type: "text" }
        ]
      }
    ],
    code: `
import json, os

def run(ctx):
    marker = os.path.join(ctx.work_dir, "marker")
    had_work = os.path.exists(marker)
    open(marker, "w").close()
    return {
        "data": {"e2e_settings_seen": [{
            "had_state": ctx.previous_state is not None,
            "had_work": had_work,
            "params": json.dumps(ctx.params, sort_keys=True),
        }]},
        "state": {"seen": True},
    }
`,
    contract: 2
  }
  await installIntegration(pool, definition)
  const runWith = async (trigger: string) => {
    await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_settings', $1, 'queued')`, [trigger])
    const run = await claimNextRun(pool, "test-worker")
    assert.ok(run)
    await executeRun(deps, run!)
    const row = await pool.query("SELECT status, error, inputs FROM app.runs WHERE id = $1", [run!.id])
    assert.equal(row.rows[0].status, "succeeded", row.rows[0].error ?? "")
    return row.rows[0].inputs
  }
  const inputs = await runWith("manual")
  await runWith("cron")
  await runWith("rebuild")
  const seen = await pool.query("SELECT had_state, had_work, params FROM data.e2e_settings_seen ORDER BY _id")
  assert.deepEqual(
    seen.rows.map(r => [r.had_state, r.had_work]),
    [[false, false], [true, true], [false, false]]
  )
  assert.deepEqual(JSON.parse(seen.rows[0].params), { months_back: 12, variant: "simplified" })
  // Lineage records the values the run executed with
  assert.deepEqual(inputs.settings, { months_back: 12, variant: "simplified" })
}, { timeout: 180_000 })

test("tiled snapshot: many files register as one snapshot; an empty one supersedes it", { skip: !AVAILABLE }, async () => {
  // First run writes two adjacent tiles; the second reports nothing observed
  const tiled: IntegrationDefinition = {
    id: "e2e_tiled",
    name: { _base: "en", en: "Tiled" },
    trigger: {},
    runtime: "python",
    destinations: [
      {
        kind: "raster",
        layerId: "e2e_tiled_layer",
        temporality: "current-only",
        bands: [{ id: "v", units: "m" }]
      }
    ],
    code: `
import numpy as np
import rasterio
from rasterio.transform import from_origin

def run(ctx):
    n = ((ctx.previous_state or {}).get("n") or 0) + 1
    if n == 2:
        return {"rasters": [{"layerId": "e2e_tiled_layer", "sources": [],
                             "timestamp": "2026-02-01T00:00:00Z"}], "state": {"n": n}}
    for i, west in enumerate([10.0, 11.0]):
        with rasterio.open(
            f"{ctx.out_dir}/tile{i}.tif", "w", driver="GTiff",
            width=100, height=100, count=1, dtype="float32",
            crs="EPSG:4326", transform=from_origin(west, 1.0, 0.01, 0.01),
        ) as dst:
            dst.write((np.ones((100, 100)) * (i + 1)).astype("float32"), 1)
    return {"rasters": [{"layerId": "e2e_tiled_layer",
                         "sources": [{"path": "tile0.tif"}, {"path": "tile1.tif"}],
                         "timestamp": f"2026-0{n}-01T00:00:00Z"}], "state": {"n": n}}
`,
    contract: 2
  }
  await installIntegration(pool, tiled)
  const runTiled = async () => {
    await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_tiled', 'manual', 'queued')`)
    const run = await claimNextRun(pool, "test-worker")
    assert.ok(run)
    await executeRun(deps, run!)
    const result = await pool.query("SELECT status, error FROM app.runs WHERE id = $1", [run!.id])
    assert.equal(result.rows[0].status, "succeeded", result.rows[0].error)
  }

  await runTiled()
  const first = await pool.query(
    `SELECT s.id, ST_XMin(s.footprint) AS w, ST_XMax(s.footprint) AS e,
            (SELECT count(*)::int FROM app.raster_sources WHERE snapshot_id = s.id) AS sources,
            (SELECT count(*)::int FROM data.rasters WHERE snapshot_id = s.id) AS registered
     FROM app.raster_snapshots s WHERE s.layer_id = 'e2e_tiled_layer' AND s.status = 'promoted'`
  )
  assert.equal(first.rows.length, 1)
  assert.equal(first.rows[0].sources, 2)
  // Snapshot footprint spans both tiles; SQL sees both files under one snapshot
  assert.equal(Number(first.rows[0].w), 10)
  assert.equal(Number(first.rows[0].e), 12)
  assert.equal(first.rows[0].registered, 2)
  const values = await pool.query(
    `SELECT ST_Value(rast, 1, ST_SetSRID(ST_MakePoint(11.5, 0.5), 4326)) AS v FROM data.rasters
     WHERE snapshot_id = $1 AND ST_Intersects(rast, ST_SetSRID(ST_MakePoint(11.5, 0.5), 4326))`,
    [first.rows[0].id]
  )
  assert.equal(values.rows.length, 1)
  assert.equal(Number(values.rows[0].v), 2)

  await runTiled()
  const after = await pool.query(
    `SELECT s.id, s.status, s.footprint IS NULL AS no_footprint, l.current_snapshot_id = s.id AS is_current,
            (SELECT count(*)::int FROM app.raster_sources WHERE snapshot_id = s.id) AS sources,
            (SELECT count(*)::int FROM data.rasters WHERE snapshot_id = s.id) AS registered
     FROM app.raster_snapshots s JOIN app.raster_layers l ON l.id = s.layer_id
     WHERE s.layer_id = 'e2e_tiled_layer' ORDER BY s.observed_at`
  )
  assert.equal(after.rows.length, 2)
  assert.equal(after.rows[0].status, "superseded")
  // The empty snapshot is current, has no footprint, and registers no pixels
  assert.equal(after.rows[1].status, "promoted")
  assert.ok(after.rows[1].is_current)
  assert.ok(after.rows[1].no_footprint)
  assert.equal(after.rows[1].sources, 0)
  assert.equal(after.rows[1].registered, 0)
}, { timeout: 180_000 })

test("lost lease: a reclaimed run commits nothing from the stale attempt", { skip: !AVAILABLE }, async () => {
  const lease: IntegrationDefinition = {
    id: "e2e_lease",
    name: { _base: "en", en: "Lease" },
    trigger: {},
    runtime: "python",
    destinations: [
      { kind: "table", tableId: "e2e_lease_rows", action: "append", columns: [{ id: "n", type: "integer" }] }
    ],
    code: `def run(ctx):\n    return {"data": {"e2e_lease_rows": [{"n": 1}]}, "state": {"stale": True}}`,
    contract: 2
  }
  await installIntegration(pool, lease)
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_lease', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "worker-a")
  assert.ok(run?.attempt)
  // The reaper expired worker-a's lease and worker-b reclaimed the run
  await pool.query("UPDATE app.runs SET attempt = gen_random_uuid(), claimed_by = 'worker-b' WHERE id = $1", [run!.id])
  await executeRun(deps, run!)

  const row = await pool.query("SELECT status, claimed_by, state_out FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(row.rows[0].status, "running", "worker-b's claim is untouched")
  assert.equal(row.rows[0].claimed_by, "worker-b")
  assert.equal(row.rows[0].state_out, null)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM data.e2e_lease_rows")).rows[0].n, 0)
  await pool.query("UPDATE app.runs SET status = 'failed', finished_at = now() WHERE id = $1", [run!.id])
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

test("secret values printed by the job are masked in the log and error", { skip: !AVAILABLE }, async () => {
  const key = randomBytes(32)
  const leaky: IntegrationDefinition = {
    ...DEFINITION,
    id: "e2e_leaky",
    secrets: ["api_token"],
    destinations: [{ kind: "table", tableId: "e2e_leaky_rows", action: "append", columns: [{ id: "site", type: "text" }] }],
    code: `import sys\ndef run(ctx):\n    print("token is " + ctx.secrets["api_token"], file=sys.stderr)\n    raise RuntimeError("rejected " + ctx.secrets["api_token"])`
  }
  await installIntegration(pool, leaky)
  await setSecret(pool, key, "e2e_leaky", "api_token", "s3cr3t-value-123")
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_leaky', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  const streamed: string[] = []
  await executeRun({ ...deps, secretKey: key }, run!, { onLogLine: line => streamed.push(line) })
  const result = await pool.query("SELECT status, error, log FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(result.rows[0].status, "failed")
  for (const text of [result.rows[0].error, result.rows[0].log ?? "", streamed.join("\n")]) {
    assert.doesNotMatch(text, /s3cr3t-value-123/)
  }
  assert.match(result.rows[0].error, /rejected \[secret:api_token\]/)
}, { timeout: 180_000 })

test("validation rules flag out-of-range and out-of-vocabulary values without rejecting them", { skip: !AVAILABLE }, async () => {
  const checked: IntegrationDefinition = {
    ...DEFINITION,
    id: "e2e_checked",
    destinations: [
      {
        kind: "table",
        tableId: "e2e_checked_rows",
        action: "replace",
        columns: [
          { id: "site", type: "text" },
          { id: "value", type: "number" },
          { id: "kind", type: "enum", enumValues: [{ id: "well", name: { _base: "en", en: "Well" } }] }
        ]
      },
      { kind: "raster", layerId: "e2e_checked_layer", temporality: "current-only", bands: [{ id: "v", units: "m" }] }
    ],
    validation: {
      ranges: [
        { destinationId: "e2e_checked_rows", field: "value", min: 0, max: 10 },
        { destinationId: "e2e_checked_layer", field: "v", max: 5 }
      ]
    },
    code: `
import numpy as np
import rasterio
from rasterio.transform import from_origin

def run(ctx):
    with rasterio.open(
        f"{ctx.out_dir}/snap.tif", "w", driver="GTiff", width=8, height=8, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_origin(44, -18, 0.01, 0.01),
    ) as dst:
        dst.write((np.ones((8, 8)) * 7).astype("float32"), 1)
    return {
        "data": {"e2e_checked_rows": [
            {"site": "a", "value": 5, "kind": "well"},
            {"site": "b", "value": -1, "kind": "spring"},
            {"site": "c", "value": 11, "kind": None},
        ]},
        "rasters": [{"layerId": "e2e_checked_layer", "path": "snap.tif", "timestamp": "2026-01-01T00:00:00Z"}],
    }
`
  }
  await installIntegration(pool, checked)
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_checked', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  await executeRun(deps, run!)
  const result = await pool.query("SELECT status, flags, log FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(result.rows[0].status, "succeeded")
  const flags = result.rows[0].flags as { destinationId: string; field: string; rule: string; count?: number; observedMax?: number }[]
  assert.deepEqual(
    flags.map(f => [f.destinationId, f.field, f.rule, f.count ?? f.observedMax]),
    [
      ["e2e_checked_layer", "v", "range", 7],
      ["e2e_checked_rows", "value", "range", 2],
      ["e2e_checked_rows", "kind", "enum", 1]
    ]
  )
  assert.match(result.rows[0].log, /flag: e2e_checked_rows\.value: 2 values outside 0 to 10/)
  // Flagged data still lands
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM data.e2e_checked_rows")).rows[0].n, 3)
}, { timeout: 180_000 })

test("derived integration: /in materialization and lineage", { skip: !AVAILABLE }, async () => {
  const derived: IntegrationDefinition = {
    id: "e2e_derived",
    name: { _base: "en", en: "Derived" },
    trigger: {},
    runtime: "python",
    inputs: {
      src: { kind: "table", tableId: "e2e_rows", format: "json" },
      snaps: { kind: "raster", layerId: "e2e_layer", select: { latest: 2 } },
      tiles: { kind: "raster", layerId: "e2e_tiled_layer", select: "current" }
    },
    destinations: [
      {
        kind: "table",
        tableId: "e2e_derived_rows",
        action: "replace",
        columns: [
          { id: "src_rows", type: "integer" },
          { id: "snap_files", type: "integer" },
          { id: "tile_value", type: "number" }
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
    # A tiled snapshot arrives as one VRT that rasterio opens like any raster
    tiles = manifest["inputs"]["tiles"]["snapshots"]
    assert len(tiles) == 1 and tiles[0]["path"].endswith(".vrt"), tiles
    import rasterio
    with rasterio.open(f"{ctx.in_dir}/{tiles[0]['path']}") as src:
        value = float(next(src.sample([(11.5, 0.5)]))[0])
    return {"data": {"e2e_derived_rows": [{"src_rows": len(rows), "snap_files": len(snaps), "tile_value": value}]}}
`,
    contract: 2
  }
  await installIntegration(pool, derived)
  const srcCount = Number((await pool.query("SELECT count(*) AS n FROM data.e2e_rows")).rows[0].n)
  // Third tiled run: tiles again (n = 3), so the current snapshot has two files
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_tiled', 'manual', 'queued')`)
  await executeRun(deps, (await claimNextRun(pool, "test-worker"))!)

  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_derived', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  await executeRun(deps, run!)

  const final = await pool.query("SELECT status, error, inputs FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(final.rows[0].status, "succeeded", final.rows[0].error ?? "")
  // Lineage: the run records exactly which snapshots and extracts fed it
  assert.equal(final.rows[0].inputs.inputs.snaps.snapshots.length, 2)
  assert.equal(final.rows[0].inputs.inputs.src.rowCount, srcCount)

  const out = await pool.query("SELECT src_rows, snap_files, tile_value FROM data.e2e_derived_rows")
  assert.equal(Number(out.rows[0].src_rows), srcCount)
  assert.equal(Number(out.rows[0].snap_files), 2)
  assert.equal(Number(out.rows[0].tile_value), 2)
}, { timeout: 180_000 })

test("table file: rows travel through /out and land atomically", { skip: !AVAILABLE }, async () => {
  const fileDef: IntegrationDefinition = {
    id: "e2e_file",
    name: { _base: "en", en: "File channel" },
    trigger: {},
    runtime: "python",
    destinations: [
      {
        kind: "table",
        tableId: "e2e_regions",
        action: "replace",
        columns: [
          { id: "code", type: "text" },
          { id: "level", type: "number" },
          { id: "boundary", type: "geometry" }
        ]
      }
    ],
    code: `
import geopandas as gpd
from shapely.geometry import Point

def run(ctx):
    n = ((ctx.previous_state or {}).get("n") or 0) + 1
    frame = gpd.GeoDataFrame(
        {"code": [f"r{i}" for i in range(n)], "level": [float(i) for i in range(n)]},
        geometry=[Point(44 + i * 0.5, -18 - i * 0.5) for i in range(n)],
        crs="EPSG:4326",
    )
    frame.to_file(f"{ctx.out_dir}/regions.fgb", driver="FlatGeobuf")
    return {"tables": [{"tableId": "e2e_regions", "path": "regions.fgb"}], "state": {"n": n}}
`,
    contract: 2
  }
  await installIntegration(pool, fileDef)

  const runFile = async (): Promise<string> => {
    await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_file', 'manual', 'queued')`)
    const run = await claimNextRun(pool, "test-worker")
    assert.ok(run)
    await executeRun(deps, run!)
    return run!.id
  }

  const firstId = await runFile()
  const first = await pool.query("SELECT status, error, stats FROM app.runs WHERE id = $1", [firstId])
  assert.equal(first.rows[0].status, "succeeded", first.rows[0].error ?? "")
  assert.equal(first.rows[0].stats.rows.e2e_regions, 1)
  const loaded = await pool.query(
    `SELECT code, level, _run_id, ST_SRID(boundary) AS srid, ST_AsGeoJSON(boundary) AS geom FROM data.e2e_regions`
  )
  assert.equal(loaded.rows[0].code, "r0")
  assert.equal(loaded.rows[0]._run_id, firstId)
  assert.equal(loaded.rows[0].srid, 4326)
  assert.deepEqual(JSON.parse(loaded.rows[0].geom).coordinates, [44, -18])

  // Second run replaces wholesale, and staging never outlives the run
  const secondId = await runFile()
  const second = await pool.query("SELECT status, error, stats FROM app.runs WHERE id = $1", [secondId])
  assert.equal(second.rows[0].status, "succeeded", second.rows[0].error ?? "")
  assert.equal(second.rows[0].stats.rows.e2e_regions, 2)
  const replaced = await pool.query("SELECT code, _run_id FROM data.e2e_regions ORDER BY code")
  assert.deepEqual(replaced.rows.map(r => r.code), ["r0", "r1"])
  assert.ok(replaced.rows.every(r => r._run_id === secondId))
  const staging = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'stage'`)
  assert.deepEqual(staging.rows, [])
}, { timeout: 180_000 })

test("workDiskMb: over-quota /work warns, then refuses the next run", { skip: !AVAILABLE }, async () => {
  const quotaDef: IntegrationDefinition = {
    id: "e2e_quota",
    name: { _base: "en", en: "Quota" },
    trigger: {},
    runtime: "python",
    limits: { workDiskMb: 1 },
    destinations: [
      { kind: "table", tableId: "e2e_quota_rows", action: "append", columns: [{ id: "n", type: "integer" }] }
    ],
    code: `
def run(ctx):
    with open(f"{ctx.work_dir}/cache.bin", "wb") as f:
        f.write(b"x" * 2 * 1024 * 1024)
    return {"data": {"e2e_quota_rows": [{"n": 1}]}}
`,
    contract: 2
  }
  await installIntegration(pool, quotaDef)
  // This is the path for a job that finishes over quota between two disk
  // polls; with the suite's 1 s poll a slow sandbox gets killed mid-job
  // instead, so this runner never polls within the test
  const unpolled = new Runner({ network: "integrator-jobs-exec", egress: "open", diskMonitorMs: 600_000 })
  const queue = async (): Promise<string> => {
    await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_quota', 'manual', 'queued')`)
    const run = await claimNextRun(pool, "test-worker")
    assert.ok(run)
    await executeRun({ ...deps, runner: unpolled }, run!)
    return run!.id
  }

  // The job that fills /work still succeeds; its log carries the warning
  const firstId = await queue()
  const first = await pool.query("SELECT status, error, log, stats FROM app.runs WHERE id = $1", [firstId])
  assert.equal(first.rows[0].status, "succeeded", first.rows[0].error ?? "")
  assert.equal(first.rows[0].stats.workMb, 2)
  assert.match(first.rows[0].log, /over the 1 MB quota/)

  // The next run refuses to start rather than growing the workspace further
  const secondId = await queue()
  const second = await pool.query("SELECT status, error FROM app.runs WHERE id = $1", [secondId])
  assert.equal(second.rows[0].status, "failed")
  assert.match(second.rows[0].error, /over the 1 MB workDiskMb quota; run cold to clear/)
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
    { id: runId, integration_id: null, trigger: "agent" },
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
  const snapshot = await pool.query(
    "SELECT src.path FROM app.raster_snapshots s JOIN app.raster_sources src ON src.snapshot_id = s.id WHERE s.layer_id = $1",
    [layers.rows[0].id]
  )
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

test("disk monitor kills a job that overruns its /work quota", { skip: !AVAILABLE }, async () => {
  await installIntegration(pool, {
    id: "e2e_hog",
    name: { _base: "en", en: "Disk hog" },
    trigger: {},
    runtime: "python",
    limits: { workDiskMb: 5, timeoutMs: 120_000 },
    destinations: [{ kind: "table", tableId: "hog_rows", action: "replace", columns: [{ id: "n", type: "integer" }] }],
    code: `import time

def run(ctx):
    with open(f"{ctx.work_dir}/blob", "wb") as f:
        f.write(b"x" * (20 * 1024 * 1024))
    time.sleep(120)
    return {"data": {"hog_rows": []}}
`,
    contract: 2
  })
  await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_hog', 'manual', 'queued')`)
  const run = await claimNextRun(pool, "test-worker")
  assert.ok(run)
  const started = Date.now()
  await executeRun({ ...deps, diskMonitorMs: 500 }, run!)
  const row = await pool.query("SELECT status, error FROM app.runs WHERE id = $1", [run!.id])
  assert.equal(row.rows[0].status, "failed")
  assert.match(row.rows[0].error, /\/work reached \d+ MB, over the 5 MB quota/)
  assert.ok(Date.now() - started < 60_000, "killed well before the sleep ended")
}, { timeout: 120_000 })

test("/tmp: each run gets its own disk-backed /tmp, removed after it, and is killed past tmpDiskMb", { skip: !AVAILABLE }, async () => {
  const tmpDefinition: IntegrationDefinition = {
    id: "e2e_tmp",
    name: { _base: "en", en: "Temporary disk" },
    trigger: {},
    runtime: "python",
    limits: { tmpDiskMb: 64, timeoutMs: 120_000 },
    settings: {
      mb: { label: { _base: "en", en: "MB" }, type: "integer", default: 0 },
      sleep: { label: { _base: "en", en: "Sleep" }, type: "boolean", default: false }
    },
    destinations: [{ kind: "table", tableId: "tmp_rows", action: "replace", columns: [{ id: "n", type: "integer" }] }],
    code: `import os, time

def run(ctx):
    leftover = os.path.exists(os.path.join(ctx.tmp_dir, "blob"))
    size = ctx.params.get("mb", 0) * 1024 * 1024
    with open(os.path.join(ctx.tmp_dir, "blob"), "wb") as f:
        f.write(b"x" * size)
    if ctx.params.get("sleep"):
        time.sleep(120)
    return {"data": {"tmp_rows": [{"n": 1 if leftover else 0}]}}
`,
    contract: 2
  }
  const runWith = async (settingValues: Record<string, number | boolean>) => {
    await installIntegration(pool, { ...tmpDefinition, settingValues })
    await pool.query(`INSERT INTO app.runs (integration_id, trigger, status) VALUES ('e2e_tmp', 'manual', 'queued')`)
    const run = await claimNextRun(pool, "test-worker")
    assert.ok(run)
    await executeRun({ ...deps, diskMonitorMs: 500 }, run!)
    return (await pool.query("SELECT status, error FROM app.runs WHERE id = $1", [run!.id])).rows[0]
  }

  for (let i = 0; i < 2; i++) {
    const ok = await runWith({ mb: 32 })
    assert.equal(ok.status, "succeeded", ok.error)
    // The second run finds nothing the first wrote
    assert.deepEqual((await pool.query("SELECT n::int AS n FROM data.tmp_rows")).rows, [{ n: 0 }])
  }
  assert.deepEqual(await readdir(path.join(deps.workRoot, JOB_TMP_DIR)), [])
  assert.deepEqual(await readdir(path.join(deps.workRoot, "e2e_tmp")), [])

  const started = Date.now()
  const hog = await runWith({ mb: 100, sleep: true })
  assert.equal(hog.status, "failed")
  assert.match(hog.error, /\/tmp reached \d+ MB, over the 64 MB quota/)
  assert.ok(Date.now() - started < 60_000, "killed well before the sleep ended")
  assert.deepEqual(await readdir(path.join(deps.workRoot, JOB_TMP_DIR)), [])
}, { timeout: 180_000 })

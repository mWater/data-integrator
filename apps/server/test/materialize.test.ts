import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { applyRows } from "../src/destinations.js"
import { materializeInputs, MaterializeDeps } from "../src/materialize.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const OGR = await execFileP("ogr2ogr", ["--version"]).then(() => true, () => false)

/** Source integration owning the table and layer the tests extract from. */
const SOURCE: IntegrationDefinition = {
  id: "mat_src",
  name: { _base: "en", en: "Materialize source" },
  trigger: {},
  runtime: "node",
  destinations: [
    {
      kind: "table",
      tableId: "mat_rows",
      action: "replace",
      columns: [
        { id: "name", type: "text" },
        { id: "value", type: "number" },
        { id: "geom", type: "geometry" }
      ]
    },
    { kind: "raster", layerId: "mat_layer", temporality: "time-series", bands: [{ id: "b1" }, { id: "b2" }] }
  ],
  code: "export default async function run() { return {} }",
  contract: 2
}

/** Derived definition shell around one input. */
function withInput(inputs: IntegrationDefinition["inputs"], runtime: IntegrationDefinition["runtime"] = "node") {
  return { ...SOURCE, id: "mat_derived", destinations: [], inputs, runtime }
}

let db: TestDb
let pool: pg.Pool
let deps: MaterializeDeps

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  await installIntegration(pool, SOURCE)

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await applyRows(
      client,
      SOURCE.destinations[0] as never,
      [
        { name: "alpha", value: 1, geom: { type: "Point", coordinates: [47, -19] } },
        { name: "beta", value: 2, geom: { type: "Point", coordinates: [45, -20] } },
        { name: "gamma", value: 3, geom: null }
      ],
      randomUUID()
    )
    await client.query("COMMIT")
  } finally {
    client.release()
  }

  const storeDir = await mkdtemp(path.join(tmpdir(), "mat-store-"))
  deps = { pool, store: new RasterStore(storeDir), databaseUrl: db.url }

  // Three promoted snapshots (Jan/Feb/Mar) plus a superseded one that must never surface
  await pool.query(
    `INSERT INTO app.runs (id, integration_id, trigger, status) VALUES ($1, 'mat_src', 'manual', 'succeeded')`,
    ["00000000-0000-4000-8000-000000000001"]
  )
  await mkdir(path.join(storeDir, "mat_layer"), { recursive: true })
  for (const [i, [month, status]] of [["01", "promoted"], ["02", "promoted"], ["03", "promoted"], ["02", "superseded"]].entries()) {
    const id = randomUUID()
    await writeFile(path.join(storeDir, "mat_layer", `${id}.tif`), `fake tif ${i}`)
    await pool.query(
      `INSERT INTO app.raster_snapshots (id, layer_id, observed_at, footprint, crs, bands, run_id, status)
       VALUES ($1, 'mat_layer', $2, ST_SetSRID(ST_MakeEnvelope(44, -20, 48, -18), 4326), 'EPSG:4326', $3,
               '00000000-0000-4000-8000-000000000001', $4)`,
      [id, `2026-${month}-01T00:00:00Z`, JSON.stringify(["b1", "b2"]), status]
    )
    await pool.query(
      `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint)
       VALUES ($1, 0, $2, ST_SetSRID(ST_MakeEnvelope(44, -20, 48, -18), 4326))`,
      [id, `mat_layer/${id}.tif`]
    )
  }
  await pool.query(
    `UPDATE app.raster_layers SET current_snapshot_id = (
       SELECT id FROM app.raster_snapshots WHERE layer_id = 'mat_layer' AND status = 'promoted'
       ORDER BY observed_at DESC LIMIT 1) WHERE id = 'mat_layer'`
  )
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

/** Runs materialization into a fresh temp dir. */
async function materialize(inputs: IntegrationDefinition["inputs"], runtime?: IntegrationDefinition["runtime"]) {
  const inDir = await mkdtemp(path.join(tmpdir(), "mat-in-"))
  const manifest = await materializeInputs(deps, withInput(inputs, runtime), inDir)
  return { inDir, manifest }
}

test("table extract: json with default columns, geometry as GeoJSON", async () => {
  const { inDir, manifest } = await materialize({ src: { kind: "table", tableId: "mat_rows", format: "json" } })
  const input = manifest.inputs.src
  assert.ok(input.kind === "table")
  assert.equal(input.rowCount, 3)
  assert.equal(input.format, "json")

  const rows = JSON.parse(await readFile(path.join(inDir, input.path), "utf8"))
  assert.equal(rows.length, 3)
  assert.deepEqual(Object.keys(rows[0]).sort(), ["geom", "name", "value"])
  assert.equal(rows.find((r: { name: string }) => r.name === "alpha").geom.type, "Point")

  const onDisk = JSON.parse(await readFile(path.join(inDir, "manifest.json"), "utf8"))
  assert.deepEqual(onDisk, manifest)
})

test("table extract: columns, where filter, csv format", async () => {
  const { inDir, manifest } = await materialize({
    src: {
      kind: "table",
      tableId: "mat_rows",
      columns: ["name", "value"],
      where: [{ column: "value", op: ">=", value: 2 }],
      format: "csv"
    }
  })
  const input = manifest.inputs.src
  assert.ok(input.kind === "table")
  assert.equal(input.rowCount, 2)
  const csv = await readFile(path.join(inDir, input.path), "utf8")
  assert.equal(csv.trim().split("\n")[0], "name,value")
  assert.equal(csv.trim().split("\n").length, 3)
  assert.doesNotMatch(csv, /alpha/)
})

test("table extract: gpkg via ogr2ogr", { skip: !OGR }, async () => {
  const { inDir, manifest } = await materialize(
    { src: { kind: "table", tableId: "mat_rows", where: [{ column: "name", op: "in", value: ["alpha", "beta"] }] } },
    "python" // gpkg is the python default
  )
  const input = manifest.inputs.src
  assert.ok(input.kind === "table")
  assert.equal(input.format, "gpkg")
  assert.equal(input.rowCount, 2)
  const { stdout } = await execFileP("ogrinfo", ["-so", "-al", path.join(inDir, input.path)])
  assert.match(stdout, /Feature Count: 2/)
})

test("table extract: unknown column and oversized guards", async () => {
  await assert.rejects(
    () => materialize({ src: { kind: "table", tableId: "mat_rows", where: [{ column: "nope; DROP", op: "=", value: 1 }] } }),
    /unknown column/
  )
  await assert.rejects(
    () => materialize({ src: { kind: "table", tableId: "missing_table", format: "json" } }),
    /does not exist/
  )
})

test("raster: current, latest N ascending, and time range", async () => {
  const current = await materialize({ r: { kind: "raster", layerId: "mat_layer", select: "current" } })
  const currentInput = current.manifest.inputs.r
  assert.ok(currentInput.kind === "raster")
  assert.equal(currentInput.snapshots.length, 1)
  assert.equal(currentInput.snapshots[0].timestamp.slice(0, 7), "2026-03")
  assert.deepEqual(currentInput.snapshots[0].bands, ["b1", "b2"])
  await access(path.join(current.inDir, currentInput.snapshots[0].path))

  const latest = await materialize({ r: { kind: "raster", layerId: "mat_layer", select: { latest: 2 } } })
  const latestInput = latest.manifest.inputs.r
  assert.ok(latestInput.kind === "raster")
  assert.deepEqual(
    latestInput.snapshots.map(s => s.timestamp.slice(5, 7)),
    ["02", "03"] // ascending, and the superseded Feb snapshot never surfaces
  )

  const range = await materialize({
    r: { kind: "raster", layerId: "mat_layer", select: { from: "2026-01-01T00:00:00Z", to: "2026-02-15T00:00:00Z" } }
  })
  const rangeInput = range.manifest.inputs.r
  assert.ok(rangeInput.kind === "raster")
  assert.deepEqual(rangeInput.snapshots.map(s => s.timestamp.slice(5, 7)), ["01", "02"])

  await assert.rejects(() => materialize({ r: { kind: "raster", layerId: "no_such_layer", select: "current" } }), /unknown layer/)
})

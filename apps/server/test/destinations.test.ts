import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { TableDestination } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import {
  ensureTable,
  applyRows,
  applyStagedTable,
  dropOrphanStagedTables,
  dropStagedTable,
  stageTableFile,
  tableFileFormat
} from "../src/destinations.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL
const OGR = await execFileP("ogr2ogr", ["--version"]).then(() => true, () => false)
const FILES_AVAILABLE = AVAILABLE && OGR

let db: TestDb
let pool: pg.Pool
let fileDir: string
const RUN_A = randomUUID()
const RUN_B = randomUUID()

const MERGE_SPEC: TableDestination = {
  kind: "table",
  tableId: "sites",
  action: "merge",
  mergeColumns: ["code"],
  columns: [
    { id: "code", type: "text" },
    { id: "level", type: "number" },
    { id: "count", type: "integer" },
    { id: "measured_at", type: "datetime" },
    { id: "location", type: "geometry" },
    { id: "extra", type: "json" }
  ]
}

before(async () => {
  if (!AVAILABLE) return
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  fileDir = await mkdtemp(path.join(tmpdir(), "table-files-"))
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await pool.end()
  await db.stop()
})

test("ensureTable creates the table with system columns and indexes", { skip: !AVAILABLE }, async () => {
  await ensureTable(pool as unknown as pg.ClientBase, MERGE_SPEC)
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'data' AND table_name = 'sites' ORDER BY ordinal_position`
  )
  const names = cols.rows.map(r => r.column_name)
  assert.deepEqual(names.slice(0, 2), ["_id", "_run_id"])
  assert.ok(names.includes("location"))
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'data' AND tablename = 'sites'`)
  const indexNames = indexes.rows.map(r => r.indexname)
  assert.ok(indexNames.some(n => n.includes("merge")), "merge unique index")
  assert.ok(indexNames.some(n => n.includes("gist")), "geometry gist index")
})

test("merge upserts on mergeColumns and stamps _run_id", { skip: !AVAILABLE }, async () => {
  const rows = [
    { code: "w1", level: 3.5, count: 10, measured_at: "2026-01-01T00:00:00Z", location: { type: "Point", coordinates: [45.2, -19.1] }, extra: { a: 1 } },
    { code: "w2", level: 1.25, count: 20, measured_at: "2026-01-02T00:00:00Z", location: null, extra: null }
  ]
  assert.equal(await applyRows(pool as unknown as pg.ClientBase, MERGE_SPEC, rows, RUN_A), 2)
  // Second run updates w2 and inserts w3
  const update = [
    { code: "w2", level: 9.75, count: 21, measured_at: "2026-01-03T00:00:00Z", location: null, extra: null },
    { code: "w3", level: 0.5, count: 1, measured_at: "2026-01-03T00:00:00Z", location: null, extra: null }
  ]
  await applyRows(pool as unknown as pg.ClientBase, MERGE_SPEC, update, RUN_B)
  const result = await pool.query(
    `SELECT code, level, count::text AS count, _run_id, ST_AsGeoJSON(location) AS loc FROM data.sites ORDER BY code`
  )
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows[1].level, 9.75)
  assert.equal(result.rows[1]._run_id, RUN_B)
  assert.equal(result.rows[0]._run_id, RUN_A)
  assert.equal(JSON.parse(result.rows[0].loc).coordinates[0], 45.2)
  assert.equal(result.rows[0].count, "10")
})

test("additive evolution adds new columns only", { skip: !AVAILABLE }, async () => {
  const evolved: TableDestination = {
    ...MERGE_SPEC,
    columns: [...MERGE_SPEC.columns, { id: "status", type: "enum", enumValues: [{ id: "ok", name: "OK" }] }]
  }
  await ensureTable(pool as unknown as pg.ClientBase, evolved)
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'data' AND table_name = 'sites'`
  )
  assert.ok(cols.rows.some(r => r.column_name === "status"))
})

/** Destination fed by table files: geometry column named unlike any file field. */
const REGIONS_SPEC: TableDestination = {
  kind: "table",
  tableId: "regions",
  action: "replace",
  columns: [
    { id: "code", type: "text" },
    { id: "level", type: "number" },
    { id: "boundary", type: "geometry" }
  ]
}

/** Non-spatial destination fed by CSV, covering every scalar cast. */
const COUNTS_SPEC: TableDestination = {
  kind: "table",
  tableId: "counts",
  action: "merge",
  mergeColumns: ["code"],
  columns: [
    { id: "code", type: "text" },
    { id: "total", type: "integer" },
    { id: "ratio", type: "number" },
    { id: "ok", type: "boolean" },
    { id: "seen_on", type: "date" }
  ]
}

/** Writes a point FeatureCollection to the test file directory. */
async function writeGeoJson(name: string, features: { code: string; level: number; at: [number, number] }[]) {
  const file = path.join(fileDir, name)
  await writeFile(
    file,
    JSON.stringify({
      type: "FeatureCollection",
      features: features.map(f => ({
        type: "Feature",
        properties: { code: f.code, level: f.level },
        geometry: { type: "Point", coordinates: f.at }
      }))
    })
  )
  return file
}

/** Stages a file, applies it, drops staging: the executor's sequence for one table. */
async function loadFile(spec: TableDestination, file: string, runId: string): Promise<number> {
  const staged = await stageTableFile(pool, db.url, spec, file, tableFileFormat({ tableId: spec.tableId, path: file }), runId)
  try {
    return await applyStagedTable(pool as unknown as pg.ClientBase, staged, runId)
  } finally {
    await dropStagedTable(pool, staged)
  }
}

test("tableFileFormat: declared wins, extension infers, unknown explains", () => {
  assert.equal(tableFileFormat({ tableId: "t", path: "a.csv", format: "geojson" }), "geojson")
  assert.equal(tableFileFormat({ tableId: "t", path: "admin1.fgb" }), "fgb")
  assert.equal(tableFileFormat({ tableId: "t", path: "sub/dir/x.GeoJSON" }), "geojson")
  assert.throws(() => tableFileFormat({ tableId: "t", path: "rows.txt" }), /declare format/)
})

test("file load: replace from GeoJSON, geometry into a differently named column", { skip: !FILES_AVAILABLE }, async () => {
  await ensureTable(pool as unknown as pg.ClientBase, REGIONS_SPEC)
  const first = await writeGeoJson("regions.geojson", [
    { code: "r1", level: 2.5, at: [45.2, -19.1] },
    { code: "r2", level: 4, at: [46, -18] }
  ])
  assert.equal(await loadFile(REGIONS_SPEC, first, RUN_A), 2)
  const rows = await pool.query(
    `SELECT code, level, _run_id, ST_SRID(boundary) AS srid, ST_AsGeoJSON(boundary) AS geom
     FROM data.regions ORDER BY code`
  )
  assert.equal(rows.rows.length, 2)
  assert.equal(rows.rows[0].level, 2.5)
  assert.equal(rows.rows[0]._run_id, RUN_A)
  assert.equal(rows.rows[0].srid, 4326)
  assert.deepEqual(JSON.parse(rows.rows[0].geom).coordinates, [45.2, -19.1])

  // A second replace swaps again: no leftover staging or __new collisions
  const second = await writeGeoJson("regions2.geojson", [{ code: "r9", level: 1, at: [44, -17] }])
  assert.equal(await loadFile(REGIONS_SPEC, second, RUN_B), 1)
  const after = await pool.query(`SELECT code, _run_id FROM data.regions`)
  assert.deepEqual(after.rows.map(r => r.code), ["r9"])
  assert.equal(after.rows[0]._run_id, RUN_B)
  const leftovers = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'stage'`
  )
  assert.deepEqual(leftovers.rows, [])
})

test("file load: merge from CSV upserts and casts empty fields to null", { skip: !FILES_AVAILABLE }, async () => {
  await ensureTable(pool as unknown as pg.ClientBase, COUNTS_SPEC)
  const first = path.join(fileDir, "counts.csv")
  await writeFile(first, "code,total,ratio,ok,seen_on\nc1,5,1.5,true,2026-01-02\nc2,,,,\n")
  assert.equal(await loadFile(COUNTS_SPEC, first, RUN_A), 2)
  const loaded = await pool.query(
    `SELECT code, total::text AS total, ratio, ok, seen_on::text AS seen_on FROM data.counts ORDER BY code`
  )
  assert.deepEqual(loaded.rows[0], { code: "c1", total: "5", ratio: 1.5, ok: true, seen_on: "2026-01-02" })
  assert.deepEqual(loaded.rows[1], { code: "c2", total: null, ratio: null, ok: null, seen_on: null })

  const update = path.join(fileDir, "counts2.csv")
  await writeFile(update, "code,total,ratio,ok,seen_on\nc2,7,0.25,false,2026-02-03\nc3,1,1,true,2026-02-04\n")
  await loadFile(COUNTS_SPEC, update, RUN_B)
  const merged = await pool.query(`SELECT code, total::text AS total, _run_id FROM data.counts ORDER BY code`)
  assert.equal(merged.rows.length, 3)
  assert.deepEqual(merged.rows[1], { code: "c2", total: "7", _run_id: RUN_B })
  assert.equal(merged.rows[0]._run_id, RUN_A)
})

test("file load: CSV geometry column as GeoJSON text, and a mislabelled format fails", { skip: !FILES_AVAILABLE }, async () => {
  await ensureTable(pool as unknown as pg.ClientBase, REGIONS_SPEC)
  const file = path.join(fileDir, "text-geom.csv")
  await writeFile(
    file,
    'code,level,boundary\n' +
      'g1,3,"{""type"":""Point"",""coordinates"":[45.5,-19.25]}"\n' +
      "g2,4,\n"
  )
  assert.equal(await loadFile(REGIONS_SPEC, file, RUN_A), 2)
  const rows = await pool.query(
    `SELECT code, ST_SRID(boundary) AS srid, ST_AsGeoJSON(boundary) AS geom FROM data.regions ORDER BY code`
  )
  assert.deepEqual(JSON.parse(rows.rows[0].geom).coordinates, [45.5, -19.25])
  assert.equal(rows.rows[0].srid, 4326)
  assert.equal(rows.rows[1].geom, null)

  // Declaring the wrong format is an error, not a silent success
  await assert.rejects(
    stageTableFile(pool, db.url, REGIONS_SPEC, file, "gpkg", RUN_B),
    /loading gpkg file failed/
  )
})

test("file load: reprojects a file that is not in 4326", { skip: !FILES_AVAILABLE }, async () => {
  await ensureTable(pool as unknown as pg.ClientBase, REGIONS_SPEC)
  const source = await writeGeoJson("mercator-src.geojson", [{ code: "m1", level: 1, at: [45.25, -19.5] }])
  const projected = path.join(fileDir, "mercator.fgb")
  await execFileP("ogr2ogr", ["-f", "FlatGeobuf", "-t_srs", "EPSG:3857", projected, source])
  await loadFile(REGIONS_SPEC, projected, RUN_A)
  const rows = await pool.query(
    `SELECT ST_SRID(boundary) AS srid, ST_X(boundary::geometry) AS lon, ST_Y(boundary::geometry) AS lat FROM data.regions`
  )
  assert.equal(rows.rows[0].srid, 4326)
  assert.ok(Math.abs(rows.rows[0].lon - 45.25) < 1e-6, `lon ${rows.rows[0].lon}`)
  assert.ok(Math.abs(rows.rows[0].lat - -19.5) < 1e-6, `lat ${rows.rows[0].lat}`)
})

test("file load: a declared column missing from the file names what the file has", { skip: !FILES_AVAILABLE }, async () => {
  const spec: TableDestination = {
    ...REGIONS_SPEC,
    tableId: "regions_strict",
    columns: [...REGIONS_SPEC.columns, { id: "population", type: "integer" }]
  }
  await ensureTable(pool as unknown as pg.ClientBase, spec)
  const file = await writeGeoJson("strict.geojson", [{ code: "s1", level: 1, at: [45, -19] }])
  await assert.rejects(loadFile(spec, file, RUN_A), /no column "population".*File columns: code, level/s)
})

test("file load: multi-layer files and duplicate merge keys fail clearly", { skip: !FILES_AVAILABLE }, async () => {
  const single = await writeGeoJson("layers.geojson", [{ code: "a", level: 1, at: [45, -19] }])
  const multi = path.join(fileDir, "multi.gpkg")
  await execFileP("ogr2ogr", ["-f", "GPKG", multi, single, "-nln", "alpha"])
  await execFileP("ogr2ogr", ["-f", "GPKG", "-update", "-append", multi, single, "-nln", "beta"])
  await assert.rejects(loadFile(REGIONS_SPEC, multi, RUN_A), /2 layers \(alpha, beta\); write one layer per file/)

  await ensureTable(pool as unknown as pg.ClientBase, COUNTS_SPEC)
  const dupes = path.join(fileDir, "dupes.csv")
  await writeFile(dupes, "code,total,ratio,ok,seen_on\nd1,1,1,true,2026-01-01\nd1,2,2,true,2026-01-02\n")
  await assert.rejects(loadFile(COUNTS_SPEC, dupes, RUN_A), /more than one row per code; deduplicate/)
})

test("orphan staging: a crashed run's tables go, a running run's stay", { skip: !FILES_AVAILABLE }, async () => {
  // A run needs exactly one owner; a session is the cheapest to conjure
  const session = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, messages, client_state, usage)
     VALUES ('designer', 'active', '[]', '{}', '{}') RETURNING id`
  )
  const live = await pool.query(
    `INSERT INTO app.runs (session_id, trigger, status, heartbeat_at)
     VALUES ($1, 'agent', 'running', now()) RETURNING id`,
    [session.rows[0].id]
  )
  const livePrefix = (live.rows[0].id as string).replace(/-/g, "").slice(0, 8)
  const deadPrefix = randomUUID().replace(/-/g, "").slice(0, 8)
  await pool.query(`CREATE SCHEMA IF NOT EXISTS stage`)
  await pool.query(`CREATE TABLE stage.${`stg_${livePrefix}_keep`} (x int)`)
  await pool.query(`CREATE TABLE stage.${`stg_${deadPrefix}_drop`} (x int)`)

  assert.equal(await dropOrphanStagedTables(pool), 1)
  const left = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'stage'`)
  assert.deepEqual(left.rows.map(r => r.table_name), [`stg_${livePrefix}_keep`])

  await pool.query(`UPDATE app.runs SET status = 'failed' WHERE id = $1`, [live.rows[0].id])
  assert.equal(await dropOrphanStagedTables(pool), 1)
})

test("replace swaps atomically and renames carried indexes", { skip: !AVAILABLE }, async () => {
  const spec: TableDestination = {
    kind: "table",
    tableId: "totals",
    action: "replace",
    columns: [{ id: "region", type: "text" }, { id: "total", type: "integer" }]
  }
  await ensureTable(pool as unknown as pg.ClientBase, spec)
  await applyRows(pool as unknown as pg.ClientBase, spec, [{ region: "north", total: 5 }], RUN_A)
  await applyRows(pool as unknown as pg.ClientBase, spec, [{ region: "south", total: 7 }, { region: "east", total: 2 }], RUN_B)
  const result = await pool.query(`SELECT region, _run_id FROM data.totals ORDER BY region`)
  assert.equal(result.rows.length, 2)
  assert.ok(result.rows.every(r => r._run_id === RUN_B))
  // Third replace must not collide on leftover __new index names
  await applyRows(pool as unknown as pg.ClientBase, spec, [{ region: "west", total: 9 }], RUN_A)
  const final = await pool.query(`SELECT count(*)::int AS n FROM data.totals`)
  assert.equal(final.rows[0].n, 1)
})

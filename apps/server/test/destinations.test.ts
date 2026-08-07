import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { TableDestination } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { ensureTable, applyRows } from "../src/destinations.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const PODMAN = await execFileP("podman", ["--version"]).then(() => true, () => false)
const AVAILABLE = PODMAN || !!process.env.TEST_DATABASE_URL

let db: TestDb
let pool: pg.Pool
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

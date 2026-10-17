import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { Server } from "node:http"
import { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { JobResult, Runner } from "@mwater/integration-runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { createApiToken, createUser } from "../src/auth.js"
import { claimNextRun, ExecutorDeps } from "../src/executor.js"
import { installIntegration } from "../src/install.js"
import { migrate } from "../src/migrations.js"
import { RasterStore } from "../src/rasterStore.js"
import { insertRunningRun, RunService } from "../src/runService.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** What every held job ends with: success and an empty result. */
const EMPTY_SUCCESS: JobResult = {
  status: "succeeded",
  exitCode: 0,
  stdout: "{}",
  stdoutTruncated: false,
  stdoutLimitBytes: 10 * 1024 * 1024,
  stderrTail: "",
  durationMs: 1
}

/** Job runner stand-in: each job blocks until the test releases it, so a run stays running as long as needed. */
class HeldRunner {
  /** Jobs started so far */
  started = 0
  private releases: (() => void)[] = []

  /** Nothing to prepare. */
  async ensureReady(): Promise<void> {}

  /** Holds the job until releaseAll. */
  run(): Promise<JobResult> {
    this.started++
    return new Promise(resolve => this.releases.push(() => resolve(EMPTY_SUCCESS)))
  }

  /** Lets every held job finish. */
  releaseAll(): void {
    for (const release of this.releases.splice(0)) release()
  }
}

/** Minimal production integration with no destinations. */
function definition(id: string): IntegrationDefinition {
  return {
    id,
    name: { _base: "en", en: id },
    trigger: {},
    runtime: "node",
    destinations: [],
    code: "export default async function run() { return {} }",
    contract: 2
  }
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let editorBearer: string
let workRoot: string
let storeRoot: string
const runner = new HeldRunner()
let runs: RunService

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 5 })
  await migrate(pool, MIGRATIONS_DIR)
  const editor = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editorBearer = await createApiToken(pool, editor.id, "editor-token")
  await installIntegration(pool, definition("rs_one"))
  await installIntegration(pool, definition("rs_other"))

  workRoot = await mkdtemp(path.join(tmpdir(), "runstart-work-"))
  storeRoot = await mkdtemp(path.join(tmpdir(), "runstart-store-"))
  const store = new RasterStore(storeRoot)
  const deps: ExecutorDeps = {
    pool,
    runner: runner as unknown as Runner,
    store,
    workRoot,
    secretKey: null,
    images: { node: "unused", python: "unused" },
    databaseUrl: db.url
  }
  runs = new RunService(deps)
  server = createApiServer(pool, new TileRenderer(store, "/nonexistent"), null, runs, store)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  runner.releaseAll()
  server?.close()
  await pool?.end()
  await db?.stop()
  await rm(workRoot, { recursive: true, force: true })
  await rm(storeRoot, { recursive: true, force: true })
})

/** POSTs a manual run as the editor. */
function startOverHttp(integrationId: string): Promise<Response> {
  return fetch(`${base}/api/integrations/${integrationId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorBearer}` }
  })
}

/** Status of one run, polled until it leaves running (5 s cap). */
async function settled(runId: string): Promise<string> {
  const deadline = Date.now() + 5000
  for (;;) {
    const status = (await pool.query("SELECT status FROM app.runs WHERE id = $1", [runId])).rows[0].status as string
    if (status !== "running" || Date.now() > deadline) return status
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Run rows of one integration in one status. */
async function countRuns(integrationId: string, status: string): Promise<number> {
  const result = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = $1 AND status = $2", [
    integrationId,
    status
  ])
  return result.rows[0].n
}

test("an idle integration starts running at once, under its own lease", async () => {
  const runId = await runs.start("rs_one")
  const row = (await pool.query("SELECT status, trigger, claimed_by, attempt FROM app.runs WHERE id = $1", [runId])).rows[0]
  assert.equal(row.status, "running")
  assert.equal(row.trigger, "manual")
  assert.equal(row.claimed_by, "api")
  assert.ok(row.attempt, "the API run carries a lease token like a worker-claimed run")
  // Never queued, so there is nothing for a scheduler worker to take
  assert.equal(await claimNextRun(pool, "test-worker"), null)

  runner.releaseAll()
  assert.equal(await settled(runId), "succeeded")
})

test("a start while a run is going is refused with 409 and leaves no row behind", async () => {
  const runId = await runs.start("rs_one")
  const before = (await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = 'rs_one'")).rows[0].n

  await assert.rejects(runs.start("rs_one"), /already running/)
  const response = await startOverHttp("rs_one")
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /already running/)

  const afterCount = (await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = 'rs_one'")).rows[0].n
  assert.equal(afterCount, before)
  assert.equal(await countRuns("rs_one", "queued"), 0)

  runner.releaseAll()
  assert.equal(await settled(runId), "succeeded")
})

test("a start while a run is queued is refused with 409; the queued run is left to the scheduler", async () => {
  const queued = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('rs_one', 'cron', 'queued') RETURNING id"
  )
  const started = runner.started

  await assert.rejects(runs.start("rs_one"), /already queued/)
  assert.equal((await startOverHttp("rs_one")).status, 409)
  assert.equal(await countRuns("rs_one", "running"), 0)
  assert.equal(await countRuns("rs_one", "queued"), 1)
  assert.equal(runner.started, started, "no job started")

  await pool.query("DELETE FROM app.runs WHERE id = $1", [queued.rows[0].id])
})

test("a direct start runs the named integration, not whatever else is queued (cli.js run)", async () => {
  await pool.query("INSERT INTO app.runs (integration_id, trigger, status, priority) VALUES ('rs_other', 'cron', 'queued', 10)")

  const run = await insertRunningRun(pool, "rs_one", "cli-test")
  assert.equal(run.integration_id, "rs_one")
  assert.ok(run.attempt)
  assert.equal(await countRuns("rs_other", "queued"), 1)
  assert.equal(await countRuns("rs_other", "running"), 0)

  await pool.query("UPDATE app.runs SET status = 'failed', finished_at = now() WHERE id = $1", [run.id])
  await pool.query("DELETE FROM app.runs WHERE integration_id = 'rs_other' AND status = 'queued'")
})


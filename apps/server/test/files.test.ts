import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest, Server } from "node:http"
import { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MockLanguageModelV4 } from "ai/test"
import pg from "pg"
import { JobResult, JobSpec, Runner } from "@mwater/integration-runner"
import { InManifest, IntegrationDefinition } from "@data-integrator/definitions"
import { createApiToken, createUser } from "../src/auth.js"
import { DesignerImplementation, DesignerState, initialDesignerState } from "../src/agent/designer.js"
import { AgentService } from "../src/agent/service.js"
import { MessageRejectedError } from "../src/agent/types.js"
import { claimNextRun, executeRun, ExecutorDeps } from "../src/executor.js"
import { limitRequestTime } from "../src/filesApi.js"
import { cleanupFileStore, FileStore } from "../src/fileStore.js"
import { installIntegration, validateDefinition } from "../src/install.js"
import { migrate } from "../src/migrations.js"
import { RasterStore } from "../src/rasterStore.js"
import { RunService } from "../src/runService.js"
import { enqueueDueRuns } from "../src/scheduler.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { getWebhookToken, receiveWebhook } from "../src/webhooks.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** How the next scripted job ends. */
type JobMode = "succeed" | "fail" | "hold"

/** What one job saw: its manifest and the contents of each file it was given. */
interface SeenJob {
  manifest: InManifest | null
  files: Record<string, string>
}

/** Job runner stand-in: records each job's /in, then succeeds, fails, or holds as scripted. */
class ScriptedRunner {
  /** Jobs run so far, oldest first */
  jobs: SeenJob[] = []
  /** Modes for the next jobs; empty means succeed */
  modes: JobMode[] = []
  private holds: (() => void)[] = []

  /** Nothing to prepare. */
  async ensureReady(): Promise<void> {}

  /** Records the job's inputs, then ends it per the next scripted mode. */
  async run(spec: JobSpec): Promise<JobResult> {
    const inDir = spec.mounts?.inDir
    let manifest: InManifest | null = null
    const files: Record<string, string> = {}
    if (inDir) {
      manifest = JSON.parse(await readFile(path.join(inDir, "manifest.json"), "utf8"))
      for (const [slotId, file] of Object.entries(manifest?.files ?? {})) {
        files[slotId] = await readFile(path.join(inDir, file.path), "utf8")
      }
    }
    this.jobs.push({ manifest, files })
    const mode = this.modes.shift() ?? "succeed"
    if (mode === "hold") await new Promise<void>(resolve => this.holds.push(resolve))
    return {
      status: mode === "fail" ? "failed" : "succeeded",
      exitCode: mode === "fail" ? 1 : 0,
      stdout: mode === "fail" ? "" : "{}",
      stdoutTruncated: false,
      stdoutLimitBytes: 10 * 1024 * 1024,
      stderrTail: mode === "fail" ? "Sheet 'Inventory' is missing column 'Latitude'" : "",
      durationMs: 1
    }
  }

  /** Resolves once a job is waiting in a hold; a job starts after the request that queued it returns. */
  async held(): Promise<void> {
    const deadline = Date.now() + 10_000
    while (this.holds.length === 0) {
      if (Date.now() > deadline) throw new Error("no job reached its hold within 10s")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Lets held jobs finish. */
  release(): void {
    for (const resolve of this.holds.splice(0)) resolve()
  }

  /** The most recent job. */
  get last(): SeenJob {
    return this.jobs[this.jobs.length - 1]
  }
}

/** An installed integration reading one spreadsheet or CSV. */
function fileDefinition(id: string, extra: Partial<IntegrationDefinition> = {}): IntegrationDefinition {
  return {
    id,
    name: { _base: "en", en: id },
    trigger: {},
    runtime: "python",
    files: { inventory: { description: { _base: "en", en: "Water point inventory" }, accept: [".xlsx", ".csv"] } },
    destinations: [],
    code: "def run(ctx): return {}",
    contract: 2,
    ...extra
  }
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let editor: string
let editorId: string
let viewer: string
let fileRoot: string
let workRoot: string
let files: FileStore
let deps: ExecutorDeps
let designer: DesignerImplementation
let agent: AgentService<DesignerState>
const runner = new ScriptedRunner()

/** Upload cap in these tests, so the 413 path needs only a little data. */
const MAX_MB = 1

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url, max: 8 })
  await migrate(pool, MIGRATIONS_DIR)
  const editorUser = await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")
  editor = await createApiToken(pool, editorUser.id, "editor")
  editorId = editorUser.id
  const viewerUser = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  viewer = await createApiToken(pool, viewerUser.id, "viewer")
  await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")

  fileRoot = await mkdtemp(path.join(tmpdir(), "files-store-"))
  workRoot = await mkdtemp(path.join(tmpdir(), "files-work-"))
  files = new FileStore(fileRoot)
  const rasterStore = new RasterStore(await mkdtemp(path.join(tmpdir(), "files-raster-")))
  deps = {
    pool,
    runner: runner as unknown as Runner,
    store: rasterStore,
    workRoot,
    files,
    secretKey: null,
    images: { python: "unused", node: "unused" },
    databaseUrl: db.url
  }
  const model = new MockLanguageModelV4({})
  designer = new DesignerImplementation({ ...deps, model })
  agent = AgentService.forDesigner(pool, { ...deps, model })
  await installIntegration(pool, fileDefinition("inv"))
  server = createApiServer(
    pool,
    new TileRenderer(rasterStore, "/nonexistent"),
    agent,
    new RunService(deps),
    rasterStore,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    { store: files, maxUploadMb: MAX_MB }
  )
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  runner.release()
  server?.close()
  await pool?.end()
  await db?.stop()
  await rm(fileRoot, { recursive: true, force: true })
  await rm(workRoot, { recursive: true, force: true })
})

/** One API call as a token holder. */
function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, { ...init, headers: { authorization: `Bearer ${bearer}`, ...init?.headers } })
}

/** Uploads a body to an integration slot. */
async function upload(
  integrationId: string,
  slotId: string,
  filename: string,
  body: string | Buffer,
  run: boolean,
  bearer = editor
): Promise<{ status: number; body: Record<string, any> }> {
  const query = new URLSearchParams({ filename, run: String(run) })
  const response = await call(`/api/integrations/${integrationId}/files/${slotId}?${query}`, bearer, {
    method: "PUT",
    body
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

/** Status of one run once it has left running (5 s cap). */
async function settled(runId: string): Promise<string> {
  const deadline = Date.now() + 5000
  for (;;) {
    const status = (await pool.query("SELECT status FROM app.runs WHERE id = $1", [runId])).rows[0].status as string
    if (status !== "running" || Date.now() > deadline) return status
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** The current version id of a slot, or null. */
async function currentOf(integrationId: string, slotId: string): Promise<string | null> {
  const row = await pool.query("SELECT current_version_id FROM app.file_slots WHERE integration_id = $1 AND slot_id = $2", [
    integrationId,
    slotId
  ])
  return row.rows[0]?.current_version_id ?? null
}

/**
 * Starts an upload that sends Expect: 100-continue and reports whether the
 * server asked for the body before answering. The body is sent only on 100.
 */
function uploadExpectingContinue(pathname: string, bearer: string, body: string): Promise<{ continued: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    let continued = false
    const req = httpRequest(`${base}${pathname}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${bearer}`, expect: "100-continue", "content-length": Buffer.byteLength(body) }
    })
    req.on("continue", () => {
      continued = true
      req.end(body)
    })
    req.on("response", response => {
      response.resume()
      response.on("end", () => resolve({ continued, status: response.statusCode ?? 0 }))
    })
    req.on("error", reject)
    req.flushHeaders()
  })
}

test("validateDefinition checks file slot ids and accept lists", () => {
  validateDefinition(fileDefinition("ok_files"))
  assert.throws(() => validateDefinition(fileDefinition("bad", { files: { "Bad Slot": {} } })), /Invalid file slot id/)
  assert.throws(() => validateDefinition(fileDefinition("bad", { files: { sheet: { accept: ["xlsx"] } } })), /Invalid extension "xlsx"/)
  assert.throws(() => validateDefinition(fileDefinition("bad", { files: { sheet: { accept: [] } } })), /non-empty list/)
})

test("an upload is refused before its body is sent, and accepted ones are asked for it", async () => {
  const csv = "name,lat\nWell 1,1.5\n"
  const target = (slot: string, filename: string, run = "true") =>
    `/api/integrations/inv/files/${slot}?${new URLSearchParams({ filename, run })}`

  for (const [pathname, bearer, status] of [
    [target("inventory", "a.csv"), viewer, 403],
    ["/api/integrations/nope/files/inventory?filename=a.csv", editor, 404],
    [target("other_slot", "a.csv"), editor, 400],
    [target("inventory", "a.pdf"), editor, 400],
    [target("inventory", "bad.e$t"), editor, 400],
    ["/api/integrations/inv/files/inventory", editor, 400]
  ] as const) {
    const outcome = await uploadExpectingContinue(pathname, bearer, csv)
    assert.deepEqual(outcome, { continued: false, status }, pathname)
  }
  const versions = await pool.query("SELECT count(*)::int AS n FROM app.file_versions")
  assert.equal(versions.rows[0].n, 0, "refused uploads store nothing")

  // A wrong type is fine when only staging (run=false): the check protects users, not the host
  const staged = await uploadExpectingContinue(target("inventory", "notes.pdf", "false"), editor, csv)
  assert.deepEqual(staged, { continued: true, status: 201 })
})

test("an upload stores a version, runs against it, and makes it current", async () => {
  const csv = "name,lat\nWell 1,1.5\nWell 2,2.5\n"
  const { status, body } = await upload("inv", "inventory", "Inventory 2026.csv", csv, true)
  assert.equal(status, 201, JSON.stringify(body))
  assert.equal(body.version.filename, "Inventory 2026.csv")
  assert.equal(body.version.sha256, createHash("sha256").update(csv).digest("hex"))
  assert.equal(body.run.status, "running")
  assert.equal(await settled(body.run.id), "succeeded")

  // The job read exactly this version, at the slot's path
  const seen = runner.last
  assert.equal(seen.manifest?.files?.inventory.path, "files/inventory.csv")
  assert.equal(seen.manifest?.files?.inventory.versionId, body.version.id)
  assert.equal(seen.files.inventory, csv)

  const run = await pool.query("SELECT file_pins, inputs FROM app.runs WHERE id = $1", [body.run.id])
  assert.deepEqual(run.rows[0].file_pins, { inventory: body.version.id })
  assert.equal(run.rows[0].inputs.files.inventory.versionId, body.version.id)
  assert.equal(await currentOf("inv", "inventory"), body.version.id)
  // Stored under its id with the validated extension, never the uploaded name
  assert.ok((await readdir(fileRoot)).includes(`${body.version.id}.csv`))
})

test("a failed run records the file it read and leaves current alone", async () => {
  const before = await currentOf("inv", "inventory")
  runner.modes.push("fail")
  const { body } = await upload("inv", "inventory", "drifted.xlsx", "not really xlsx", true)
  assert.equal(await settled(body.run.id), "failed")
  const run = await pool.query("SELECT inputs, error FROM app.runs WHERE id = $1", [body.run.id])
  assert.equal(run.rows[0].inputs.files.inventory.versionId, body.version.id, "lineage written before the job")
  assert.match(run.rows[0].error, /missing column 'Latitude'/)
  assert.equal(await currentOf("inv", "inventory"), before)
})

test("pinned runs queue behind a running one and merge into the queued run", async () => {
  runner.modes.push("hold")
  const first = await upload("inv", "inventory", "v.csv", "first\n", true)
  assert.equal(first.body.run.status, "running")

  const second = await upload("inv", "inventory", "v.csv", "second\n", true)
  assert.equal(second.body.run.status, "queued")
  const third = await upload("inv", "inventory", "v.csv", "third\n", true)
  assert.equal(third.body.run.status, "queued")
  assert.equal(third.body.run.id, second.body.run.id, "the newer pin joins the queued run")
  const queued = await pool.query("SELECT id, file_pins FROM app.runs WHERE integration_id = 'inv' AND status = 'queued'")
  assert.equal(queued.rows.length, 1)
  assert.deepEqual(queued.rows[0].file_pins, { inventory: third.body.version.id })

  // A plain manual run keeps its 409 while busy
  assert.equal((await call("/api/integrations/inv/run", editor, { method: "POST" })).status, 409)

  await runner.held()
  runner.release()
  assert.equal(await settled(first.body.run.id), "succeeded")
  // No scheduler in this test: drain the queue by hand, as a worker would
  const claimed = await claimNextRun(pool, "test-worker")
  assert.equal(claimed?.id, second.body.run.id)
  await executeRun(deps, claimed!)
  assert.equal(runner.last.files.inventory, "third\n")
  assert.equal(await currentOf("inv", "inventory"), third.body.version.id)
})

test("a queued run ignores pins for a slot the definition dropped before it started", async () => {
  await installIntegration(pool, fileDefinition("dropped_slot"))
  runner.modes.push("hold")
  const first = await upload("dropped_slot", "inventory", "v.csv", "first\n", true)
  const second = await upload("dropped_slot", "inventory", "v.csv", "second\n", true)
  assert.equal(second.body.run.status, "queued")
  await pool.query("UPDATE app.integrations SET definition = definition - 'files' WHERE id = 'dropped_slot'")

  await runner.held()
  runner.release()
  assert.equal(await settled(first.body.run.id), "succeeded")
  const claimed = await claimNextRun(pool, "test-worker")
  assert.equal(claimed?.id, second.body.run.id)
  await executeRun(deps, claimed!)
  assert.equal(await settled(second.body.run.id), "succeeded")
  assert.deepEqual(runner.last.files, {})
})

test("revert: a run pinning an older version makes it current on success; foreign pins are refused", async () => {
  const listing = await (await call("/api/integrations/inv/files", editor)).json()
  const versions = listing.slots[0].versions as { id: string; version: number }[]
  const v1 = versions.find(v => v.version === 2)! // v1 was the staged pdf; v2 the first real upload
  const response = await call("/api/integrations/inv/run", editor, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { inventory: v1.id } })
  })
  assert.equal(response.status, 202)
  const { runId, status } = await response.json()
  assert.equal(status, "running")
  assert.equal(await settled(runId), "succeeded")
  assert.equal(await currentOf("inv", "inventory"), v1.id)

  // The staged pdf is this slot's, but not on its accept list
  const pdf = versions.find(v => v.version === 1)!
  const wrongType = await call("/api/integrations/inv/run", editor, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { inventory: pdf.id } })
  })
  assert.equal(wrongType.status, 400)
  assert.match((await wrongType.json()).error, /accepts \.xlsx, \.csv/)

  await installIntegration(pool, fileDefinition("inv_other"))
  const foreign = await call("/api/integrations/inv_other/run", editor, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { inventory: v1.id } })
  })
  assert.equal(foreign.status, 400)
})

test("an empty slot refuses manual runs and is skipped by cron and webhooks", async () => {
  await installIntegration(pool, fileDefinition("inv_empty", { trigger: { cron: "* * * * *", webhook: true } }))
  const manual = await call("/api/integrations/inv_empty/run", editor, { method: "POST" })
  assert.equal(manual.status, 400)
  assert.match((await manual.json()).error, /Awaiting file upload for slot inventory/)
  await enqueueDueRuns(deps, new Date())
  const token = await getWebhookToken(pool, "inv_empty")
  const receipt = await receiveWebhook(pool, token!, { reading: 1 })
  assert.equal(receipt?.runId, null)
  const rows = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = 'inv_empty'")
  assert.equal(rows.rows[0].n, 0, "no run row exists")
  const events = await pool.query("SELECT count(*)::int AS n FROM app.webhook_events WHERE integration_id = 'inv_empty'")
  assert.equal(events.rows[0].n, 1, "the event waits for the upload's run")
})

test("viewers see versions without filenames or uploaders; downloads are editor-only and inert", async () => {
  const asViewer = (await (await call("/api/integrations/inv/files", viewer)).json()).slots[0]
  assert.equal(asViewer.versions[0].filename, null)
  assert.equal(asViewer.versions[0].uploadedBy, null)
  assert.ok(asViewer.bytesStored > 0)
  assert.ok(asViewer.versions.some((v: { runs: unknown[] }) => v.runs.length > 0), "lineage is visible to viewers")
  const asEditor = (await (await call("/api/integrations/inv/files", editor)).json()).slots[0]
  assert.equal(asEditor.versions.at(-1).uploadedBy, "editor@example.org")

  await upload("inv", "inventory", "Données é.csv", "<svg onload=alert(1)>", false)
  const latest = (await (await call("/api/integrations/inv/files", editor)).json()).slots[0].versions[0]
  const url = `/api/integrations/inv/files/inventory/versions/${latest.id}/download`
  assert.equal((await call(url, viewer)).status, 403)
  const download = await call(url, editor)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get("content-type"), "application/octet-stream")
  assert.equal(download.headers.get("x-content-type-options"), "nosniff")
  assert.equal(download.headers.get("content-security-policy"), "sandbox")
  assert.equal(download.headers.get("cache-control"), "private, no-store")
  assert.equal(
    download.headers.get("content-disposition"),
    `attachment; filename="Donn_es _.csv"; filename*=UTF-8''Donn%C3%A9es%20%C3%A9.csv`
  )
  assert.equal(await download.text(), "<svg onload=alert(1)>")
  assert.equal((await call(`/api/integrations/inv/files/other/versions/${latest.id}/download`, editor)).status, 404)
})

test("an upload past the cap gets 413 and leaves nothing behind", async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM app.file_versions")).rows[0].n
  const { status, body } = await upload("inv", "inventory", "big.csv", Buffer.alloc(MAX_MB * 1024 * 1024 + 4096, 97), false)
  assert.equal(status, 413)
  assert.match(body.error, /1 MB upload limit/)
  assert.deepEqual(await readdir(path.join(fileRoot, ".tmp")), [])
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.file_versions")).rows[0].n, before)
})

test("purge refuses current and in-use versions, then deletes the bytes and keeps the row", async () => {
  const { purgeVersion } = await import("../src/files.js")
  const current = (await currentOf("inv", "inventory"))!
  await assert.rejects(purgeVersion(pool, files, current, "admin@example.org"), /is the current version/)

  const failed = await pool.query(
    `SELECT v.id, v.ext FROM app.file_versions v WHERE v.integration_id = 'inv' AND v.filename = 'drifted.xlsx'`
  )
  const target = failed.rows[0]
  const queued = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status, file_pins) VALUES ('inv', 'manual', 'queued', $1) RETURNING id",
    [JSON.stringify({ inventory: target.id })]
  )
  await assert.rejects(purgeVersion(pool, files, target.id, "admin@example.org"), /queued run/)
  await pool.query("DELETE FROM app.runs WHERE id = $1", [queued.rows[0].id])

  const purged = await purgeVersion(pool, files, target.id, "admin@example.org")
  assert.ok(purged.purgedAt)
  await assert.rejects(stat(files.versionPath(target.id, target.ext)), /ENOENT/)
  const row = await pool.query("SELECT sha256, purged_by FROM app.file_versions WHERE id = $1", [target.id])
  assert.equal(row.rows[0].purged_by, "admin@example.org")
  assert.ok(row.rows[0].sha256, "lineage still resolves")

  const download = await call(`/api/integrations/inv/files/inventory/versions/${target.id}/download`, editor)
  assert.equal(download.status, 410)
  const pinned = await call("/api/integrations/inv/run", editor, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { inventory: target.id } })
  })
  assert.equal(pinned.status, 400)
  assert.match((await pinned.json()).error, /was purged/)
})

test("store cleanup removes only old leftovers with no live row", async () => {
  const live = (await pool.query("SELECT id, ext FROM app.file_versions WHERE purged_at IS NULL LIMIT 1")).rows[0]
  const orphan = path.join(fileRoot, "0f0f0f0f-1111-4222-8333-444455556666.csv")
  const youngOrphan = path.join(fileRoot, "1f0f0f0f-1111-4222-8333-444455556666.csv")
  const unrelated = path.join(fileRoot, "README.txt")
  const staleTmp = path.join(fileRoot, ".tmp", "abandoned")
  const staleJob = path.join(fileRoot, ".jobs", "job-old")
  await mkdir(staleJob, { recursive: true })
  for (const file of [orphan, youngOrphan, unrelated, staleTmp]) await writeFile(file, "x")
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  for (const entry of [orphan, unrelated, staleTmp, staleJob, files.versionPath(live.id, live.ext)]) await utimes(entry, old, old)

  assert.equal(await cleanupFileStore(pool, files), 3)
  const remaining = await readdir(fileRoot)
  assert.ok(!remaining.includes(path.basename(orphan)))
  assert.ok(remaining.includes(path.basename(youngOrphan)), "may belong to another process's upload in flight")
  assert.ok(remaining.includes("README.txt"), "names unlike versions are never touched")
  assert.ok(remaining.includes(`${live.id}${live.ext}`))
  assert.deepEqual(await readdir(path.join(fileRoot, ".jobs")), [])
})

test("deleting an integration deletes its file versions and their bytes", async () => {
  await installIntegration(pool, fileDefinition("inv_doomed"))
  const { body } = await upload("inv_doomed", "inventory", "d.csv", "doomed\n", false)
  const response = await call("/api/integrations/inv_doomed", editor, { method: "DELETE" })
  assert.equal(response.status, 200)
  assert.equal((await pool.query("SELECT 1 FROM app.file_versions WHERE id = $1", [body.version.id])).rows.length, 0)
  await assert.rejects(stat(files.versionPath(body.version.id, ".csv")), /ENOENT/)
})

/** A designer session row for direct designer calls. */
async function designerSession(state: DesignerState): Promise<string> {
  const row = await pool.query(
    `INSERT INTO app.agent_sessions (kind, status, messages, client_state, usage)
     VALUES ('designer', 'paused', '[]', $1, '{}') RETURNING id`,
    [JSON.stringify(state)]
  )
  return row.rows[0].id
}

/** Stages a session attachment over HTTP. */
async function attach(sessionId: string, slot: string, filename: string, body: string): Promise<Record<string, any>> {
  const response = await call(`/api/sessions/${sessionId}/files/${slot}?${new URLSearchParams({ filename })}`, editor, {
    method: "PUT",
    body
  })
  assert.equal(response.status, 201)
  return (await response.json()).version
}

test("a new session's attachment waits for its draft row, then the integration adopts it", async () => {
  const sessionId = await designerSession(initialDesignerState())
  const version = await attach(sessionId, "points", "Points.xlsx", "sheet bytes")
  const owned = await pool.query("SELECT integration_id, session_id FROM app.file_versions WHERE id = $1", [version.id])
  assert.equal(owned.rows[0].integration_id, null)
  assert.equal(owned.rows[0].session_id, sessionId)

  const prepared = await designer.prepareMessage(sessionId, initialDesignerState(), "Build me this", [
    { slot: "points", versionId: version.id }
  ])
  assert.match(prepared.text, /^\[Uploaded Points\.xlsx \(v1, 11 bytes\) to file slot "points"; snippets and runs see it at \/in\/files\/points\.xlsx\]\n\nBuild me this$/)
  assert.deepEqual(prepared.state.files, { points: version.id })

  const written = await designer.execute(
    "write_definition",
    {
      definitionJson: JSON.stringify({
        id: "points_from_file",
        name: "Points",
        trigger: {},
        runtime: "python",
        files: { points: { accept: [".xlsx"] } },
        destinations: [],
        contract: 2
      })
    },
    prepared.state,
    () => {},
    sessionId
  )
  assert.match(written.result, /Validation: valid/)
  assert.match(written.result, /points: Points\.xlsx \(v1, 11 bytes\) at \/in\/files\/points\.xlsx, attached in this session/)
  const adopted = await pool.query("SELECT integration_id FROM app.file_versions WHERE id = $1", [version.id])
  assert.equal(adopted.rows[0].integration_id, "points_from_file")

  // Another session's upload is not this one's to pin
  const otherSession = await designerSession(initialDesignerState())
  await assert.rejects(
    designer.prepareMessage(otherSession, initialDesignerState(), "mine?", [{ slot: "points", versionId: version.id }]),
    MessageRejectedError
  )
})

test("runs read the session's pins; finish needs the cold run's files and runs them in production", async () => {
  const sessionId = await designerSession(initialDesignerState())
  const v1 = await attach(sessionId, "sheet", "a.csv", "first,file\n")
  let state = (await designer.prepareMessage(sessionId, initialDesignerState(), "go", [{ slot: "sheet", versionId: v1.id }])).state
  const write = await designer.execute(
    "write_definition",
    {
      definitionJson: JSON.stringify({
        id: "sheet_rows",
        name: "Sheet rows",
        description: "Rows from an uploaded sheet",
        trigger: {},
        runtime: "python",
        files: { sheet: {} },
        destinations: [],
        contract: 2
      })
    },
    state,
    () => {},
    sessionId
  )
  state = write.state as DesignerState
  state = (await designer.execute("edit_code", { oldString: "", newString: "def run(ctx): return {}" }, state, () => {}, sessionId)).state as DesignerState

  const cold = await designer.execute("run_integration", { cold: true }, state, () => {}, sessionId)
  assert.match(cold.result, /Cold run succeeded/, cold.result)
  assert.equal(runner.last.files.sheet, "first,file\n")
  state = cold.state as DesignerState
  assert.deepEqual(state.coldRun?.files, { sheet: v1.id })

  // A new attachment after the cold run voids the certificate for finish
  const v2 = await attach(sessionId, "sheet", "b.csv", "second,file\n")
  const moved = (await designer.prepareMessage(sessionId, state, "use this one", [{ slot: "sheet", versionId: v2.id }])).state
  const rejected = await designer.execute("finish", { summary: "done" }, moved, () => {}, sessionId)
  assert.equal(rejected.finished, undefined)
  assert.match(rejected.result, /files this session reads changed since the cold run/)

  const recold = await designer.execute("run_integration", { cold: true }, moved, () => {}, sessionId)
  assert.equal(runner.last.files.sheet, "second,file\n")
  const finished = await designer.execute("finish", { summary: "done" }, recold.state as DesignerState, () => {}, sessionId)
  assert.equal(finished.finished, true, finished.result)
  assert.match(finished.result, /first data load is already running/)

  // Design runs are scratch runs; the certified file reaches production through a pinned run
  const production = await pool.query(
    "SELECT id, file_pins FROM app.runs WHERE integration_id = 'sheet_rows' ORDER BY scheduled_at DESC LIMIT 1"
  )
  assert.deepEqual(production.rows[0].file_pins, { sheet: v2.id })
  assert.equal(await settled(production.rows[0].id), "succeeded")
  assert.equal(await currentOf("sheet_rows", "sheet"), v2.id)
})

test("a session on an installed integration starts with the files its latest run read", async () => {
  const latestRun = await pool.query(
    "SELECT inputs->'files'->'inventory'->>'versionId' AS id FROM app.runs WHERE integration_id = 'inv' AND inputs ? 'files' ORDER BY scheduled_at DESC LIMIT 1"
  )
  const sessionId = await agent.createSession("inv")
  const state = (await agent.getSession(sessionId))!.state as DesignerState
  assert.deepEqual(state.files, { inventory: latestRun.rows[0].id })
  assert.equal(state.filesNote, true)
  const prepared = await designer.prepareMessage(sessionId, state, "It broke", [])
  assert.match(prepared.text, /^\[File slot "inventory" holds .*, the version this integration's latest run read; snippets and runs see it at \/in\/files\/inventory\.(csv|xlsx)\]/)
  assert.equal(prepared.state.filesNote, false)
})

test("viewers cannot open or list design sessions", async () => {
  const sessionId = await agent.createSession("inv")
  assert.equal((await call(`/api/sessions/${sessionId}`, viewer)).status, 403)
  assert.equal((await call(`/api/sessions/${sessionId}`, editor)).status, 200)
  const listed = (await (await call("/api/sessions", viewer)).json()).sessions as { kind: string }[]
  assert.ok(listed.every(s => s.kind !== "designer"))
  const upload = await call(`/api/sessions/${sessionId}/files/inventory?filename=a.csv`, viewer, { method: "PUT", body: "x" })
  assert.equal(upload.status, 403)
})

test("an upload the client abandons midway leaves no partial file and no version", async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM app.file_versions")).rows[0].n
  await new Promise<void>(resolve => {
    const req = httpRequest(`${base}/api/integrations/inv/files/inventory?filename=cut.csv&run=false`, {
      method: "PUT",
      headers: { authorization: `Bearer ${editor}`, "content-length": 500_000 }
    })
    req.on("error", () => resolve())
    req.write(Buffer.alloc(100_000, 98), () => setTimeout(() => {
      req.destroy()
      resolve()
    }, 100))
  })
  // The server notices the closed socket asynchronously
  const deadline = Date.now() + 3000
  while ((await readdir(path.join(fileRoot, ".tmp"))).length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.deepEqual(await readdir(path.join(fileRoot, ".tmp")), [])
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.file_versions")).rows[0].n, before)
})

test("session labels skip the file notes prepended to the first message", async () => {
  const sessionId = await agent.createSession("inv")
  const note = '[Uploaded a.csv (v3, 10 bytes) to file slot "inventory"; snippets and runs see it at /in/files/inventory.csv]'
  await pool.query("UPDATE app.agent_sessions SET messages = $2 WHERE id = $1", [
    sessionId,
    JSON.stringify([{ role: "user", content: `${note}\n${note}\n\nWhy did the last run fail?` }])
  ])
  const listed = (await agent.listSessions()).find(s => s.id === sessionId)
  assert.equal(listed?.firstMessage, "Why did the last run fail?")
  assert.equal((await agent.getSession(sessionId))?.firstMessage, "Why did the last run fail?")
})

test("staging a body whose client already left settles at once and leaves nothing", async () => {
  const { PassThrough } = await import("node:stream")
  const body = new PassThrough()
  body.destroy()
  await new Promise(resolve => setImmediate(resolve))
  // Earlier tests share the store, so compare against what was already there
  const before = await readdir(path.join(fileRoot, ".tmp")).catch(() => [] as string[])
  await assert.rejects(files.stage(body, 1024), /aborted by the client/)
  const after = await readdir(path.join(fileRoot, ".tmp"))
  assert.deepEqual(after.filter(name => !before.includes(name)), [])
})

test("a long filename is shortened without losing its extension", async () => {
  const name = `${"a".repeat(300)}.final report.csv`
  const { status, body } = await upload("inv", "inventory", name, "x\n", false)
  assert.equal(status, 201)
  assert.equal(body.version.filename.length, 255)
  assert.ok(body.version.filename.endsWith(".csv"))
  const row = await pool.query("SELECT ext FROM app.file_versions WHERE id = $1", [body.version.id])
  assert.equal(row.rows[0].ext, ".csv")
})

test("finish refuses to certify a version older than the slot's current one", async () => {
  // The session starts from the version the latest run read
  const sessionId = await agent.createSession("sheet_rows")
  let state = (await agent.getSession(sessionId))!.state as DesignerState
  const seeded = state.files!.sheet
  state = (await designer.prepareMessage(sessionId, state, "tweak it", [])).state

  // Meanwhile a colleague uploads and runs a newer file on the integration page
  const newer = await upload("sheet_rows", "sheet", "c.csv", "third,file\n", true)
  assert.equal(await settled(newer.body.run.id), "succeeded")
  assert.equal(await currentOf("sheet_rows", "sheet"), newer.body.version.id)

  const cold = await designer.execute("run_integration", { cold: true }, state, () => {}, sessionId)
  assert.match(cold.result, /Cold run succeeded/, cold.result)
  assert.deepEqual((cold.state as DesignerState).coldRun?.files, { sheet: seeded })
  const finish = await designer.execute("finish", { summary: "done" }, cold.state as DesignerState, () => {}, sessionId)
  assert.equal(finish.finished, undefined)
  assert.match(finish.result, /slot sheet now reads v\d+ \(c\.csv\), newer than the v\d+ this session certified/)
  assert.equal(await currentOf("sheet_rows", "sheet"), newer.body.version.id, "nothing reverted")
})

test("a new session cannot name its draft after another session's unsaved draft", async () => {
  const definitionJson = JSON.stringify({ id: "shared_name", name: "Shared", trigger: {}, runtime: "python", destinations: "invalid", contract: 2 })
  const first = await designerSession(initialDesignerState())
  const firstWrite = await designer.execute("write_definition", { definitionJson }, initialDesignerState(), () => {}, first)
  assert.match(firstWrite.result, /INVALID/, "bound, but no draft row")
  await pool.query("UPDATE app.agent_sessions SET client_state = $2 WHERE id = $1", [first, JSON.stringify(firstWrite.state)])
  const second = await designerSession(initialDesignerState())
  const secondWrite = await designer.execute("write_definition", { definitionJson }, initialDesignerState(), () => {}, second)
  assert.match(secondWrite.result, /being designed in another session/)
})

test("deleting an abandoned design session frees its id and its uploads; only its creator may", async () => {
  const definitionJson = JSON.stringify({ id: "abandoned_name", name: "A", trigger: {}, runtime: "python", destinations: "invalid", contract: 2 })
  const abandoned = await designerSession(initialDesignerState())
  const write = await designer.execute("write_definition", { definitionJson }, initialDesignerState(), () => {}, abandoned)
  await pool.query("UPDATE app.agent_sessions SET client_state = $2, user_id = $3 WHERE id = $1", [
    abandoned,
    JSON.stringify(write.state),
    editorId
  ])
  const staged = await attach(abandoned, "inventory", "a.csv", "abandoned\n")
  const other = await createUser(pool, "editor2@example.org", "hunter2hunter2", "editor")
  const otherEditor = await createApiToken(pool, other.id, "editor")
  assert.equal((await call(`/api/sessions/${abandoned}`, otherEditor, { method: "DELETE" })).status, 403)

  assert.equal((await call(`/api/sessions/${abandoned}`, editor, { method: "DELETE" })).status, 200)
  assert.equal((await pool.query("SELECT 1 FROM app.file_versions WHERE id = $1", [staged.id])).rows.length, 0)
  await assert.rejects(stat(files.versionPath(staged.id, ".csv")), /ENOENT/)
  const next = await designerSession(initialDesignerState())
  const claimed = await designer.execute("write_definition", { definitionJson }, initialDesignerState(), () => {}, next)
  assert.doesNotMatch(claimed.result, /another session/)
})

test("a design session whose integration exists is not deleted; deleting the integration frees the id", async () => {
  await installIntegration(pool, fileDefinition("installed_name"))
  const session = await designerSession(initialDesignerState("installed_name"))
  await pool.query("UPDATE app.agent_sessions SET user_id = $2 WHERE id = $1", [session, editorId])
  const refused = await call(`/api/sessions/${session}`, editor, { method: "DELETE" })
  assert.equal(refused.status, 409)
  assert.match((await refused.json()).error, /delete the integration/)

  assert.equal((await call("/api/integrations/installed_name", editor, { method: "DELETE" })).status, 200)
  const state = (await pool.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [session])).rows[0].client_state
  assert.equal(state.definition.id, "")
  const definitionJson = JSON.stringify({ id: "installed_name", name: "B", trigger: {}, runtime: "python", destinations: "invalid", contract: 2 })
  const next = await designerSession(initialDesignerState())
  const claimed = await designer.execute("write_definition", { definitionJson }, initialDesignerState(), () => {}, next)
  assert.doesNotMatch(claimed.result, /another session|already installed/)
})

test("a request that is not an upload is cut off when its body is still arriving at the deadline", async () => {
  const slow = createServer((req, res) => {
    limitRequestTime(req, res, 100)
    req.resume()
    req.on("end", () => res.end("done"))
  })
  await new Promise<void>(resolve => slow.listen(0, "127.0.0.1", resolve))
  const { port } = slow.address() as AddressInfo
  try {
    const outcome = await new Promise<string>(resolve => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/login", method: "POST", headers: { "content-length": 10 } })
      req.on("response", () => resolve("answered"))
      req.on("error", () => resolve("dropped"))
      req.write("{")
    })
    assert.equal(outcome, "dropped")
    // A request that finishes sending in time is answered
    const done = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", body: "{}" })
    assert.equal(await done.text(), "done")
  } finally {
    slow.close()
  }
})

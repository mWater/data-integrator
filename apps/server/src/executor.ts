import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, statfs, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import pg from "pg"
import { CatalogLayerState, JobHandle, JobPayload, JobResult, JOB_LIMIT_DEFAULTS, RasterArtifact, Runner, parseJobOutput } from "@mwater/integration-runner"
import { IntegrationDefinition, JobLimitsSpec, RunResult } from "@data-integrator/definitions"
import {
  applyRows,
  applyStagedTable,
  dropStagedTable,
  ensureTable,
  StagedTable,
  stageTableFile,
  tableFileFormat
} from "./destinations.js"
import { ensureScratchLayer, resolveArtifactPath, storeArtifact, registerSnapshot } from "./catalog.js"
import { materializeInputs } from "./materialize.js"
import { FileStore } from "./fileStore.js"
import { ResolvedFiles, resolveFiles, setCurrentVersions } from "./files.js"
import { RasterStore } from "./rasterStore.js"
import { createDraftSchema, draftSchema, scratchLayerId, scratchWorkDir } from "./scratch.js"
import { createJobTmp } from "./jobTmp.js"
import { getSecrets, secretRedactor } from "./secrets.js"
import { evaluateRasterRules, evaluateTableRules, RunFlag } from "./validation.js"
import { resolveSettings } from "./integrationSettings.js"
import { getDefaultAoi } from "./settings.js"
import { SandboxBudget } from "./sandboxBudget.js"
import { enableOutDbSession, pruneRasterSql, registerRasterSqlInTx, validateRasterSqlRef } from "./rasterSql.js"
import { logSecurityEvent } from "./securityLog.js"

const execFileP = promisify(execFile)

/** Everything the executor needs from its host. */
export interface ExecutorDeps {
  pool: pg.Pool
  runner: Runner
  store: RasterStore
  /** Root for persistent per-integration /work directories */
  workRoot: string
  /** Uploaded file versions; absent on hosts that never run file-reading integrations */
  files?: FileStore
  /** Encryption key for secrets; null when no definitions use secrets */
  secretKey: Buffer | null
  /** Runtime image per RuntimeId */
  images: Record<string, string>
  /** Connection URL for tools that cannot use the pool (ogr2ogr extracts) */
  databaseUrl: string
  /** /work ceiling and default in MB; absent or 0 leaves only workDiskMb */
  workQuotaMb?: number
  /** Per-run /tmp ceiling and default in MB; absent or 0 leaves only tmpDiskMb */
  tmpQuotaMb?: number
  /** Free-space floor in MB on the work root and raster store; absent or 0 disables */
  minFreeDiskMb?: number
  /** Ceilings on a definition's cpus, memoryMb and timeoutMs; absent or 0 leaves each uncapped */
  jobMax?: { cpus?: number; memoryMb?: number; timeoutMs?: number }
  /** Host-wide sandbox memory budget; absent admits every job immediately */
  sandboxes?: SandboxBudget
  /** Disk monitor poll interval; tests shorten it (default 30s) */
  diskMonitorMs?: number
}

/** How often a running worker refreshes its lease. */
const HEARTBEAT_MS = 15_000

/** Heartbeat age after which the reaper treats a run's lease as expired. */
export const LEASE_STALE_MS = 5 * 60_000

/**
 * A worker that cannot reach the database kills its own job once this long has
 * passed since its last successful heartbeat, a margin before the reaper could
 * expire the lease and let a replacement claim the run.
 */
const SELF_FENCE_MS = LEASE_STALE_MS - 60_000

/** Most recent promoted snapshots listed per layer in the job's catalog. */
const CATALOG_SNAPSHOT_LIMIT = 100

/** Memory a job reserves from the host budget when its definition sets no limit (the runner default). */
export const DEFAULT_JOB_MEMORY_MB = 2048

/** Free megabytes on the filesystem holding the path; null when unknowable. */
export async function freeDiskMb(target: string): Promise<number | null> {
  try {
    const stats = await statfs(target)
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024))
  } catch {
    return null
  }
}

/**
 * The /work quota a run executes under: the definition's workDiskMb capped by
 * the deployment ceiling, or the ceiling itself when the definition declares
 * nothing. Null means unlimited (no ceiling configured, nothing declared).
 */
export function effectiveWorkQuotaMb(
  definition: IntegrationDefinition,
  deps: Pick<ExecutorDeps, "workQuotaMb">
): number | null {
  const declared = definition.limits?.workDiskMb ?? null
  const ceiling = deps.workQuotaMb || null
  if (ceiling === null) return declared
  return declared === null ? ceiling : Math.min(declared, ceiling)
}

/**
 * The /tmp quota a run executes under: the definition's tmpDiskMb capped by
 * the deployment ceiling, or the ceiling itself when the definition declares
 * nothing. Null means unlimited (the free-space floor still applies).
 */
export function effectiveTmpQuotaMb(
  limits: IntegrationDefinition["limits"],
  deps: Pick<ExecutorDeps, "tmpQuotaMb">
): number | null {
  const declared = limits?.tmpDiskMb ?? null
  const ceiling = deps.tmpQuotaMb || null
  if (ceiling === null) return declared
  return declared === null ? ceiling : Math.min(declared, ceiling)
}

/** Job limits after the deployment ceilings, plus a log line per value they lowered. */
export interface EffectiveJobLimits {
  /** CPU cores */
  cpus: number
  /** Memory in MB */
  memoryMb: number
  /** Wall-clock timeout in ms */
  timeoutMs: number
  /** Run-log lines naming each requested limit a ceiling lowered */
  notes: string[]
}

/**
 * The cpus, memory and timeout a job executes under: the requested limits
 * (runner defaults where none are given), each lowered to the deployment
 * ceiling. Definitions are authored by editors and the agent, so the
 * deployment, not the definition, decides how much of the host one job may hold.
 */
export function effectiveJobLimits(
  requested: JobLimitsSpec | undefined,
  deps: Pick<ExecutorDeps, "jobMax">
): EffectiveJobLimits {
  const notes: string[] = []
  const cap = (name: string, asked: number | undefined, fallback: number, ceiling: number | undefined, env: string): number => {
    const value = asked ?? fallback
    if (!ceiling || value <= ceiling) return value
    if (asked !== undefined) notes.push(`limits.${name} ${asked} lowered to the deployment maximum ${ceiling} (${env})`)
    return ceiling
  }
  const max = deps.jobMax ?? {}
  return {
    cpus: cap("cpus", requested?.cpus, JOB_LIMIT_DEFAULTS.cpus, max.cpus, "JOB_MAX_CPUS"),
    memoryMb: cap("memoryMb", requested?.memoryMb, DEFAULT_JOB_MEMORY_MB, max.memoryMb, "JOB_MAX_MEMORY_MB"),
    timeoutMs: cap("timeoutMs", requested?.timeoutMs, JOB_LIMIT_DEFAULTS.timeoutMs, max.timeoutMs, "JOB_MAX_TIMEOUT_MIN"),
    notes
  }
}

/** Exit code of a container whose process was SIGKILLed, which is how the kernel ends a job over its memory limit. */
const KILLED_EXIT_CODE = 137

/**
 * Why a job that was not aborted through its handle failed, in one line. A
 * job killed for memory prints nothing of its own, so without this line its
 * error would be whatever progress it last wrote.
 */
export function jobFailureReason(result: Pick<JobResult, "exitCode" | "memoryPeakBytes">, memoryMb: number): string {
  if (result.exitCode === KILLED_EXIT_CODE) {
    const peak = result.memoryPeakBytes !== undefined ? `; peak ${Math.round(result.memoryPeakBytes / (1024 * 1024))} MB including the sandbox` : ""
    return `killed (exit code ${KILLED_EXIT_CODE}), most likely for exceeding its ${memoryMb} MB memory limit${peak}`
  }
  return result.exitCode === null ? "the job process could not be observed" : `exit code ${result.exitCode}`
}

/** Largest raster artifact `metadata`, serialized; it is lineage, not data. */
export const SNAPSHOT_METADATA_MAX_BYTES = 64 * 1024

/** Rejects artifact metadata that is not a JSON object or is too large to keep on every snapshot. */
export function checkSnapshotMetadata(artifact: Pick<RasterArtifact, "layerId" | "metadata">): void {
  const metadata: unknown = artifact.metadata
  if (metadata === undefined || metadata === null) return
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Artifact for ${artifact.layerId}: metadata must be a JSON object`)
  }
  const bytes = Buffer.byteLength(JSON.stringify(metadata))
  if (bytes > SNAPSHOT_METADATA_MAX_BYTES) {
    throw new Error(
      `Artifact for ${artifact.layerId}: metadata is ${bytes} bytes, over the ${SNAPSHOT_METADATA_MAX_BYTES}-byte limit`
    )
  }
}

/** One row of app.runs the executor cares about. */
export interface RunRow {
  id: string
  /** Owning integration; null for session scratch runs */
  integration_id: string | null
  /** How the run was started; "rebuild" runs cold */
  trigger: string
  /** Lease token of this claim; null for scratch runs the designer executes directly */
  attempt: string | null
}

/** Container label carrying the run id, so orphaned job containers can be found. */
export const RUN_LABEL = "data-integrator.run"

/**
 * Claims the next queued run: flips it to running under this worker's lease.
 * The one-running-per-integration index may reject a candidate whose
 * integration is busy; such candidates are skipped, not errors.
 */
export async function claimNextRun(pool: pg.Pool, workerId: string): Promise<RunRow | null> {
  const client = await pool.connect()
  try {
    // Scratch (session) runs are executed by the designer in-process, never claimed here
    const candidates = await client.query(
      `SELECT id FROM app.runs WHERE status = 'queued' AND scheduled_at <= now() AND integration_id IS NOT NULL
       ORDER BY scheduled_at LIMIT 10`
    )
    for (const candidate of candidates.rows) {
      try {
        const claimed = await client.query(
          `UPDATE app.runs
           SET status = 'running', claimed_by = $2, attempt = gen_random_uuid(), heartbeat_at = now(), started_at = now()
           WHERE id = $1 AND status = 'queued'
           RETURNING id, integration_id, trigger, attempt`,
          [candidate.id, workerId]
        )
        if (claimed.rows.length > 0) return claimed.rows[0] as RunRow
      } catch (err) {
        // Unique violation: another run of this integration is already running
        if ((err as { code?: string }).code !== "23505") throw err
      }
    }
    return null
  } finally {
    client.release()
  }
}

/** Marks runs whose worker lease went stale as failed, releasing the one-running constraint. */
export async function reapStaleRuns(pool: pg.Pool, staleMs = LEASE_STALE_MS): Promise<number> {
  const result = await pool.query(
    `UPDATE app.runs SET status = 'failed', finished_at = now(), error = 'worker lease expired'
     WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1)
     RETURNING id, integration_id`,
    [staleMs / 1000]
  )
  for (const row of result.rows) {
    if (row.integration_id) {
      logSecurityEvent("run.finished", { runId: row.id, integrationId: row.integration_id, status: "failed", error: "worker lease expired" })
    }
  }
  return result.rowCount ?? 0
}

/**
 * Resolves the definition's tri-state AOI: an explicit Aoi stands, explicit
 * null strips the field (full source extent), absent inherits the deployment
 * default. The job's code sees only a concrete aoi or none at all.
 */
export function resolveAoi(
  definition: IntegrationDefinition,
  defaultAoi: { bbox: [number, number, number, number]; countries?: string[] } | null
): IntegrationDefinition {
  if (definition.aoi === null) {
    const { aoi: _ignored, ...rest } = definition
    return rest as IntegrationDefinition
  }
  if (definition.aoi === undefined && defaultAoi) {
    return {
      ...definition,
      aoi: { bbox: defaultAoi.bbox, ...(defaultAoi.countries ? { countries: defaultAoi.countries } : {}) }
    }
  }
  return definition
}

/** Per-run execution options. */
export interface RunOptions {
  /** Cold run: wipe /work and pass null previousState (the certification gate). A run with trigger "rebuild" is always cold. */
  cold?: boolean
  /** Receives each job stderr line as it streams */
  onLogLine?: (line: string) => void
  /**
   * Scratch mode: the run belongs to a design session. The given draft
   * definition executes against the session's scratch area (draft schema,
   * scratch preview layers, session /work); installed integrations are never
   * consulted or touched.
   */
  scratch?: {
    /** Owning design session */
    sessionId: string
    /** Draft definition to execute */
    definition: IntegrationDefinition
    /** The session's file pins per slot; declared slots without one read the integration's current version */
    files?: Record<string, string>
  }
}

/**
 * Executes one claimed run to completion, implementing the commit protocol:
 * job first, files into the store next, then a single transaction for rows,
 * snapshot registration, webhook consumption, state, and the status flip.
 */
export async function executeRun(deps: ExecutorDeps, run: RunRow, opts?: RunOptions): Promise<void> {
  // The heartbeat renews this attempt's lease. When the row no longer carries
  // it (the reaper expired the lease and a replacement claimed the run), the
  // job is killed rather than allowed to race the replacement to the commit.
  // A worker cut off from the database fences itself: past SELF_FENCE_MS its
  // lease may be reaped, so the job is killed before it could commit twice.
  const cold = opts?.cold === true || run.trigger === "rebuild"
  let jobHandle: JobHandle | null = null
  let lastHeartbeat = Date.now()
  const heartbeat = setInterval(() => {
    deps.pool
      .query(
        `UPDATE app.runs SET heartbeat_at = now()
         WHERE id = $1 AND status = 'running' AND attempt IS NOT DISTINCT FROM $2`,
        [run.id, run.attempt]
      )
      .then(result => {
        if (result.rowCount === 0) jobHandle?.abort("lease lost: the run was reclaimed by another worker")
        else lastHeartbeat = Date.now()
      })
      // A job's /in under the file store is a leftover to boot cleanup once
      // its mtime is an hour old; a live job keeps it young
      .then(() => (inDir ? utimes(inDir, new Date(), new Date()).catch(() => {}) : undefined))
      .catch(() => {
        if (Date.now() - lastHeartbeat > SELF_FENCE_MS) {
          jobHandle?.abort("lease lost: the database was unreachable for too long to keep the lease")
        }
      })
  }, HEARTBEAT_MS)

  const scratch = opts?.scratch ?? null
  let outDir: string | null = null
  let inDir: string | null = null
  let jobTmpDir: string | null = null
  // Masks the run's secret values in everything job output feeds
  let redact = (text: string) => text
  const stagedTables: StagedTable[] = []
  try {
    let definition: IntegrationDefinition
    let definitionVersion: number | null = null
    if (scratch) {
      definition = scratch.definition
    } else {
      const integrationResult = await deps.pool.query(
        "SELECT definition, version FROM app.integrations WHERE id = $1",
        [run.integration_id]
      )
      const row = integrationResult.rows[0]
      definition = row.definition
      definitionVersion = row.version
    }
    // Tri-state AOI: explicit box wins, explicit null means full source
    // extent, absent inherits the deployment default
    const defaultAoi = definition.aoi === undefined ? await getDefaultAoi(deps.pool) : null
    definition = resolveAoi(definition, defaultAoi)

    // Pins were fixed when the run was created; declared slots without one
    // read their current version, and a slot with neither refuses the run.
    // A queued run can outlive its slot (a session renames or drops it before
    // the run starts), so pins for slots no longer declared are ignored.
    const declaredSlots = Object.keys(definition.files ?? {})
    const declaredPins = (pins: Record<string, string> | null | undefined) =>
      Object.fromEntries(Object.entries(pins ?? {}).filter(([slotId]) => declaredSlots.includes(slotId)))
    let files: ResolvedFiles = {}
    if (declaredSlots.length > 0) {
      if (scratch) {
        files = await resolveFiles(deps.pool, {
          integrationId: definition.id,
          definition,
          pins: declaredPins(scratch.files),
          sessionId: scratch.sessionId
        })
      } else {
        const pinned = await deps.pool.query("SELECT file_pins FROM app.runs WHERE id = $1", [run.id])
        files = await resolveFiles(deps.pool, { integrationId: run.integration_id!, definition, pins: declaredPins(pinned.rows[0]?.file_pins) })
      }
    }

    let manifest = null
    const readsFiles = Object.keys(files).length > 0
    if (readsFiles || (definition.inputs && Object.keys(definition.inputs).length > 0)) {
      // Under the file store when versions are read, so they hardlink in
      if (readsFiles && !deps.files) throw new Error("This integration reads uploaded files but no file store is configured")
      inDir = readsFiles ? await deps.files!.jobDir() : await mkdtemp(path.join(tmpdir(), "job-in-"))
      manifest = await materializeInputs(deps, definition, inDir, files)
    }
    // Lineage records the AOI the run actually executed with: the deployment
    // default resolves at run time, so the definition alone cannot answer
    // "what area did run X ingest". Written before the job starts, so a
    // failed run still records which inputs and files it read.
    const params = resolveSettings(definition)
    const inputs = JSON.stringify({ ...(manifest ?? {}), aoi: definition.aoi ?? null, settings: params })
    await deps.pool.query(
      `UPDATE app.runs SET inputs = $2 WHERE id = $1 AND status = 'running' AND attempt IS NOT DISTINCT FROM $3`,
      [run.id, inputs, run.attempt]
    )

    const image = deps.images[definition.runtime]
    if (!image) throw new Error(`No image configured for runtime ${definition.runtime}`)

    const secrets = definition.secrets?.length
      ? await getSecrets(deps.pool, requireKey(deps), definition.id, definition.secrets)
      : {}
    redact = secretRedactor(secrets)
    let previousState: unknown = null
    if (!cold) {
      const stateResult = scratch
        ? await deps.pool.query(
            `SELECT state_out FROM app.runs
             WHERE session_id = $1 AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
            [scratch.sessionId]
          )
        : await deps.pool.query(
            `SELECT state_out FROM app.runs
             WHERE integration_id = $1 AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
            [run.integration_id]
          )
      previousState = stateResult.rows[0]?.state_out ?? null
    }
    const webhookEvents = scratch
      ? { rows: [] as { id: string; payload: unknown }[] }
      : await deps.pool.query(
          `SELECT id, payload FROM app.webhook_events
           WHERE integration_id = $1 AND run_id IS NULL ORDER BY received_at`,
          [run.integration_id]
        )

    const catalog = await catalogState(deps.pool, definition, scratch ? scratch.sessionId : null)

    const workDir = scratch
      ? scratchWorkDir(deps.workRoot, scratch.sessionId)
      : path.join(deps.workRoot, run.integration_id!)
    if (cold) await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { recursive: true })
    // The /work quota is a between-runs check, not a kernel limit: a job over
    // quota does not start, and /work is a cache, so a cold run clears it
    const workQuotaMb = effectiveWorkQuotaMb(definition, deps)
    if (workQuotaMb !== null) {
      const usedMb = await dirUsageMb(workDir)
      if (usedMb !== null && usedMb > workQuotaMb) {
        throw new Error(
          `/work holds ${usedMb} MB, over the ${workQuotaMb} MB workDiskMb quota; run cold to clear the workspace`
        )
      }
    }
    const floorMb = deps.minFreeDiskMb || null
    if (floorMb !== null) {
      for (const target of [deps.workRoot, deps.store.root]) {
        const freeMb = await freeDiskMb(target)
        if (freeMb !== null && freeMb < floorMb) {
          throw new Error(`Only ${freeMb} MB free under ${target}, below the ${floorMb} MB floor; not starting`)
        }
      }
    }
    outDir = await mkdtemp(path.join(tmpdir(), "job-out-"))
    const jobOutDir = outDir
    jobTmpDir = await createJobTmp(deps.workRoot, "run")
    const tmpDir = jobTmpDir
    const tmpQuotaMb = effectiveTmpQuotaMb(definition.limits, deps)

    const logParts: string[] = []
    const started = Date.now()
    // The runner polls /work against workDiskMb and kills the job itself. The
    // free-space floor is a deployment concern (the store shares the disk), so
    // that guard stays here, on the same cadence
    let diskTimer: ReturnType<typeof setInterval> | null = null
    const payload: JobPayload = {
      definition,
      secrets,
      previousState,
      webhookData: webhookEvents.rows.length ? webhookEvents.rows.map(r => r.payload) : undefined,
      params,
      catalog
    }
    // The lease heartbeat is already running, so queueing here for host
    // memory cannot get the run reaped as stale
    const limits = effectiveJobLimits(definition.limits, deps)
    for (const note of limits.notes) {
      logParts.push(note)
      opts?.onLogLine?.(note)
    }
    const memoryMb = limits.memoryMb
    const releaseMemory = deps.sandboxes
      ? await deps.sandboxes.acquire(memoryMb, reason => {
          logParts.push(reason)
          opts?.onLogLine?.(reason)
        })
      : () => {}
    const runJob = () =>
      deps.runner.run(
      {
        image,
        payload,
        mounts: { workDir, outDir: jobOutDir, inDir: inDir ?? undefined, tmpDir },
        limits: {
          cpus: limits.cpus,
          memoryMb: limits.memoryMb,
          timeoutMs: limits.timeoutMs,
          workDiskMb: workQuotaMb ?? undefined,
          tmpDiskMb: tmpQuotaMb ?? undefined
        },
        labels: { [RUN_LABEL]: run.id }
      },
      {
        onStderrLine: raw => {
          const line = redact(raw)
          logParts.push(line)
          opts?.onLogLine?.(line)
        },
        onStart: handle => {
          jobHandle = handle
          const floorMb = deps.minFreeDiskMb || null
          if (floorMb === null) return
          let checking = false
          diskTimer = setInterval(async () => {
            if (checking) return
            checking = true
            try {
              for (const target of [deps.workRoot, deps.store.root]) {
                const freeMb = await freeDiskMb(target)
                if (freeMb !== null && freeMb < floorMb) {
                  handle.abort(`Only ${freeMb} MB free under ${target}, below the ${floorMb} MB floor`)
                  return
                }
              }
            } finally {
              checking = false
            }
          }, deps.diskMonitorMs ?? 30_000)
        }
      }
    )
    let jobResult
    try {
      jobResult = await runJob()
    } finally {
      releaseMemory()
    }
    if (diskTimer !== null) clearInterval(diskTimer)
    jobHandle = null
    let workUsedMb: number | null = null
    if (workQuotaMb !== null) {
      workUsedMb = await dirUsageMb(workDir)
      if (workUsedMb !== null && workUsedMb > workQuotaMb) {
        logParts.push(
          `warning: /work holds ${workUsedMb} MB, over the ${workQuotaMb} MB quota; the next run will refuse to start`
        )
      }
    }
    if (jobResult.status === "failed" && jobResult.abortedReason === undefined) {
      logParts.push(jobFailureReason(jobResult, memoryMb))
    }
    const log = logParts.join("\n").slice(-256 * 1024)

    if (jobResult.status !== "succeeded") {
      const stderr = redact(jobResult.stderrTail).slice(-2000)
      const timedOut = jobResult.status === "timeout"
      await finishRun(deps.pool, run, timedOut ? "timeout" : "failed", {
        error:
          jobResult.abortedReason ??
          (timedOut ? stderr || `exit code ${jobResult.exitCode}` : [jobFailureReason(jobResult, memoryMb), stderr].filter(Boolean).join("\n")),
        log
      })
      return
    }

    const output = parseJobOutput<RunResult>(jobResult)
    const schema = scratch ? draftSchema(scratch.sessionId) : "data"
    const layerRowFor = (layerId: string) => (scratch ? scratchLayerId(scratch.sessionId, layerId) : layerId)

    // Scratch destinations are provisioned lazily, on the first successful run
    if (scratch) {
      const client = await deps.pool.connect()
      try {
        await createDraftSchema(client, scratch.sessionId)
        for (const dest of definition.destinations) {
          if (dest.kind === "table") await ensureTable(client, dest, schema)
          else await ensureScratchLayer(client, scratch.sessionId, layerRowFor(dest.layerId), dest)
        }
      } finally {
        client.release()
      }
    }

    // Files into the store before the transaction; failures leave GC-able orphans
    const layerSpecs = new Map(
      definition.destinations.filter(d => d.kind === "raster").map(d => [d.layerId, d] as const)
    )
    const storedArtifacts = []
    for (const artifact of output.rasters ?? []) {
      const layer = layerSpecs.get(artifact.layerId)
      if (!layer) throw new Error(`Artifact for undeclared layer ${artifact.layerId}`)
      checkSnapshotMetadata(artifact)
      storedArtifacts.push({
        artifact,
        layer,
        stored: await storeArtifact(
          deps.store,
          outDir,
          artifact,
          layer.bands.map(b => b.id),
          layerRowFor(artifact.layerId)
        )
      })
    }

    // Range rules on bands read the stored files, so they run outside the transaction
    const flags: RunFlag[] = []
    for (const { artifact, layer, stored } of storedArtifacts) {
      const files = stored.sources.map(source => path.resolve(deps.store.absolute(source.relPath)))
      flags.push(...(await evaluateRasterRules(definition, artifact.layerId, layer.bands.map(b => b.id), files)))
    }

    const tableSpecs = new Map(
      definition.destinations.filter(d => d.kind === "table").map(d => [d.tableId, d] as const)
    )

    // Table files into staging before the transaction, for the same reason
    // rasters go to the store first: ogr2ogr cannot join the commit, so only
    // the staged rows do. Staging tables are dropped in the finally.
    for (const artifact of output.tables ?? []) {
      const spec = tableSpecs.get(artifact.tableId)
      if (!spec) throw new Error(`Table file for undeclared table ${artifact.tableId}`)
      if (output.data?.[artifact.tableId]) {
        throw new Error(`Table ${artifact.tableId} arrived both as inline rows and as a file; return one or the other`)
      }
      stagedTables.push(
        await stageTableFile(
          deps.pool,
          deps.databaseUrl,
          spec,
          resolveArtifactPath(outDir, artifact.path),
          tableFileFormat(artifact),
          run.id
        )
      )
    }

    const client = await deps.pool.connect()
    try {
      if (!scratch && storedArtifacts.length > 0) await enableOutDbSession(client)
      await client.query("BEGIN")
      const rowCounts: Record<string, number> = {}
      for (const [tableId, rows] of Object.entries(output.data ?? {})) {
        const spec = tableSpecs.get(tableId)
        if (!spec) throw new Error(`Rows for undeclared table ${tableId}`)
        rowCounts[tableId] = await applyRows(client, spec, rows, run.id, schema)
      }
      for (const staged of stagedTables) {
        rowCounts[staged.spec.tableId] = await applyStagedTable(client, staged, run.id, schema)
      }
      flags.push(...(await evaluateTableRules(client, definition, schema, run.id, Object.keys(rowCounts))))
      for (const { artifact, layer, stored } of storedArtifacts) {
        await registerSnapshot(client, run.id, artifact, stored, layer.temporality, layerRowFor(artifact.layerId))
        // SQL is a first-class consumer of raster data: a snapshot the
        // database cannot register out-db fails the run (and rolls back the
        // promotion) instead of silently missing from the query surface.
        // Scratch previews stay out of the public query surface but are
        // validated the same way, so certification catches registration
        // failures during design rather than on the first production run.
        try {
          const ref = {
            snapshotId: stored.snapshotId,
            layerId: layerRowFor(artifact.layerId),
            observedAt: artifact.timestamp,
            observedEnd: artifact.timestampEnd ?? null,
            crs: stored.crs,
            absolutePaths: stored.sources.map(source => path.resolve(deps.store.absolute(source.relPath)))
          }
          if (scratch) await validateRasterSqlRef(client, ref)
          else await registerRasterSqlInTx(client, ref)
        } catch (err) {
          throw new Error(
            `raster SQL registration failed for ${artifact.layerId}: ${err instanceof Error ? err.message : err}`
          )
        }
      }
      if (webhookEvents.rows.length > 0) {
        await client.query("UPDATE app.webhook_events SET run_id = $1 WHERE id = ANY($2)", [
          run.id,
          webhookEvents.rows.map(r => r.id)
        ])
      }
      // The lease check rides in the commit transaction: zero rows means the
      // reaper expired this attempt and another worker owns the run now, so
      // everything above rolls back instead of landing twice
      const committed = await client.query(
        `UPDATE app.runs SET status = 'succeeded', finished_at = now(), state_out = $2,
           definition_version = $3, stats = $4, log = $5, inputs = $6, flags = $8
         WHERE id = $1 AND status = 'running' AND attempt IS NOT DISTINCT FROM $7`,
        [
          run.id,
          output.state !== undefined ? JSON.stringify(output.state) : null,
          definitionVersion,
          JSON.stringify({
            rows: rowCounts,
            snapshots: storedArtifacts.length,
            durationMs: Date.now() - started,
            ...(workUsedMb !== null ? { workMb: workUsedMb } : {})
          }),
          flags.length > 0 ? [log, ...flags.map(f => `flag: ${f.message}`)].join("\n") : log,
          inputs,
          run.attempt,
          flags.length > 0 ? JSON.stringify(flags) : null
        ]
      )
      if (committed.rowCount === 0) throw new Error("lease lost: the run was reclaimed by another worker")
      // The files this run read become current with the data they produced
      if (!scratch && manifest?.files) await setCurrentVersions(client, run.integration_id!, manifest.files)
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
    if (!scratch) logSecurityEvent("run.finished", { runId: run.id, integrationId: run.integration_id, status: "succeeded" })

    // Post-commit, best-effort: drop registrations of snapshots this run
    // superseded; the next run prunes again if this misses
    if (!scratch && storedArtifacts.length > 0) {
      await pruneRasterSql(deps.pool).catch(() => {})
    }
  } catch (err) {
    await finishRun(deps.pool, run, "failed", {
      error: redact(err instanceof Error ? err.message : String(err)),
      log: null
    })
  } finally {
    clearInterval(heartbeat)
    for (const staged of stagedTables) await dropStagedTable(deps.pool, staged)
    if (outDir) await rm(outDir, { recursive: true, force: true })
    if (inDir) await rm(inDir, { recursive: true, force: true })
    if (jobTmpDir) await rm(jobTmpDir, { recursive: true, force: true })
  }
}

/** Disk usage of a directory in MB; null when it cannot be measured. */
async function dirUsageMb(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP("du", ["-sk", dir])
    const kb = Number(stdout.trim().split(/\s+/)[0])
    return Number.isFinite(kb) ? Math.round(kb / 1024) : null
  } catch {
    return null
  }
}

/** Writes a terminal non-success state for a run; a lost lease leaves the replacement's row alone. */
async function finishRun(
  pool: pg.Pool,
  run: RunRow,
  status: "failed" | "timeout",
  fields: { error: string; log: string | null }
): Promise<void> {
  const result = await pool.query(
    `UPDATE app.runs SET status = $2, finished_at = now(), error = $3, log = COALESCE($4, log)
     WHERE id = $1 AND status = 'running' AND attempt IS NOT DISTINCT FROM $5`,
    [run.id, status, fields.error, fields.log, run.attempt]
  )
  if ((result.rowCount ?? 0) > 0 && run.integration_id) {
    logSecurityEvent("run.finished", { runId: run.id, integrationId: run.integration_id, status, error: fields.error })
  }
}

/**
 * What the job may already have published, per declared raster destination:
 * the most recent promoted snapshots of the layer (the session's scratch
 * layer during design), bounded so long-lived daily layers stay small. Code uses it to skip work it has done.
 */
async function catalogState(
  pool: pg.Pool,
  definition: IntegrationDefinition,
  sessionId: string | null
): Promise<Record<string, CatalogLayerState>> {
  const catalog: Record<string, CatalogLayerState> = {}
  for (const dest of definition.destinations) {
    if (dest.kind !== "raster") continue
    const layerRowId = sessionId ? scratchLayerId(sessionId, dest.layerId) : dest.layerId
    const result = await pool.query(
      `SELECT * FROM (
         SELECT s.observed_at, s.observed_end,
                (SELECT count(*)::int FROM app.raster_sources WHERE snapshot_id = s.id) AS sources
         FROM app.raster_snapshots s WHERE s.layer_id = $1 AND s.status = 'promoted'
         ORDER BY s.observed_at DESC LIMIT $2
       ) recent ORDER BY observed_at`,
      [layerRowId, CATALOG_SNAPSHOT_LIMIT]
    )
    catalog[dest.layerId] = {
      snapshots: result.rows.map(row => ({
        timestamp: row.observed_at.toISOString(),
        ...(row.observed_end ? { timestampEnd: row.observed_end.toISOString() } : {}),
        sources: row.sources
      }))
    }
  }
  return catalog
}

/** Secret key or a clear error when definitions need secrets and none is configured. */
function requireKey(deps: ExecutorDeps): Buffer {
  if (!deps.secretKey) throw new Error("INTEGRATOR_SECRET_KEY is not configured")
  return deps.secretKey
}

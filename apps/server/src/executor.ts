import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pg from "pg"
import { Runner, parseJobOutput } from "@data-integrator/runner"
import { IntegrationDefinition, RunResult } from "@data-integrator/definitions"
import { applyRows, ensureTable } from "./destinations.js"
import { ensureScratchLayer, storeArtifact, registerSnapshot } from "./catalog.js"
import { materializeInputs } from "./materialize.js"
import { RasterStore } from "./rasterStore.js"
import { draftSchema, scratchLayerId, scratchWorkDir } from "./scratch.js"
import { getSecrets } from "./secrets.js"
import { getDefaultAoi } from "./settings.js"

/** Everything the executor needs from its host. */
export interface ExecutorDeps {
  pool: pg.Pool
  runner: Runner
  store: RasterStore
  /** Root for persistent per-integration /work directories */
  workRoot: string
  /** Encryption key for secrets; null when no definitions use secrets */
  secretKey: Buffer | null
  /** Runtime image per RuntimeId */
  images: Record<string, string>
  /** Connection URL for tools that cannot use the pool (ogr2ogr extracts) */
  databaseUrl: string
}

/** How often a running worker refreshes its lease. */
const HEARTBEAT_MS = 15_000

/** One row of app.runs the executor cares about. */
interface RunRow {
  id: string
  /** Owning integration; null for session scratch runs */
  integration_id: string | null
  params: unknown
}

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
       ORDER BY priority DESC, scheduled_at LIMIT 10`
    )
    for (const candidate of candidates.rows) {
      try {
        const claimed = await client.query(
          `UPDATE app.runs
           SET status = 'running', claimed_by = $2, heartbeat_at = now(), started_at = now()
           WHERE id = $1 AND status = 'queued'
           RETURNING id, integration_id, params`,
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
export async function reapStaleRuns(pool: pg.Pool, staleMs = 5 * 60_000): Promise<number> {
  const result = await pool.query(
    `UPDATE app.runs SET status = 'failed', finished_at = now(), error = 'worker lease expired'
     WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1)`,
    [staleMs / 1000]
  )
  return result.rowCount ?? 0
}

/** Definition with deployment overrides applied (trigger, limits). */
function effectiveDefinition(definition: IntegrationDefinition, overrides: Record<string, unknown>): IntegrationDefinition {
  return { ...definition, ...overrides }
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
  /** Cold run: wipe /work and pass null previousState (the certification gate) */
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
  }
}

/**
 * Executes one claimed run to completion, implementing the commit protocol:
 * job first, files into the store next, then a single transaction for rows,
 * snapshot registration, webhook consumption, state, and the status flip.
 */
export async function executeRun(deps: ExecutorDeps, run: RunRow, opts?: RunOptions): Promise<void> {
  const heartbeat = setInterval(() => {
    deps.pool.query("UPDATE app.runs SET heartbeat_at = now() WHERE id = $1", [run.id]).catch(() => {})
  }, HEARTBEAT_MS)

  const scratch = opts?.scratch ?? null
  let outDir: string | null = null
  let inDir: string | null = null
  try {
    let definition: IntegrationDefinition
    let definitionVersion: number | null = null
    if (scratch) {
      definition = scratch.definition
    } else {
      const integrationResult = await deps.pool.query(
        "SELECT definition, version, overrides FROM app.integrations WHERE id = $1",
        [run.integration_id]
      )
      const row = integrationResult.rows[0]
      definition = effectiveDefinition(row.definition, row.overrides)
      definitionVersion = row.version
    }
    // Tri-state AOI: explicit box wins, explicit null means full source
    // extent, absent inherits the deployment default
    const defaultAoi = definition.aoi === undefined ? await getDefaultAoi(deps.pool) : null
    definition = resolveAoi(definition, defaultAoi)

    let manifest = null
    if (definition.inputs && Object.keys(definition.inputs).length > 0) {
      inDir = await mkdtemp(path.join(tmpdir(), "job-in-"))
      manifest = await materializeInputs(deps, definition, inDir)
    }

    const image = deps.images[definition.runtime]
    if (!image) throw new Error(`No image configured for runtime ${definition.runtime}`)

    const secrets = definition.secrets?.length
      ? await getSecrets(deps.pool, requireKey(deps), definition.secrets)
      : {}
    let previousState: unknown = null
    if (!opts?.cold) {
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

    const workDir = scratch
      ? scratchWorkDir(deps.workRoot, scratch.sessionId)
      : path.join(deps.workRoot, run.integration_id!)
    if (opts?.cold) await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { recursive: true })
    outDir = await mkdtemp(path.join(tmpdir(), "job-out-"))

    const logParts: string[] = []
    const started = Date.now()
    const jobResult = await deps.runner.run(
      {
        image,
        payload: {
          definition,
          secrets,
          previousState,
          webhookData: webhookEvents.rows.length ? webhookEvents.rows.map(r => r.payload) : undefined,
          params: run.params ?? {}
        },
        mounts: { workDir, outDir, inDir: inDir ?? undefined },
        limits: definition.limits
          ? { cpus: definition.limits.cpus, memoryMb: definition.limits.memoryMb, timeoutMs: definition.limits.timeoutMs }
          : undefined
      },
      {
        onStderrLine: line => {
          logParts.push(line)
          opts?.onLogLine?.(line)
        }
      }
    )
    const log = logParts.join("\n").slice(-256 * 1024)

    if (jobResult.status !== "succeeded") {
      await finishRun(deps.pool, run.id, jobResult.status === "timeout" ? "timeout" : "failed", {
        error: jobResult.stderrTail.slice(-2000) || `exit code ${jobResult.exitCode}`,
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
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
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

    const tableSpecs = new Map(
      definition.destinations.filter(d => d.kind === "table").map(d => [d.tableId, d] as const)
    )
    const client = await deps.pool.connect()
    try {
      await client.query("BEGIN")
      const rowCounts: Record<string, number> = {}
      for (const [tableId, rows] of Object.entries(output.data ?? {})) {
        const spec = tableSpecs.get(tableId)
        if (!spec) throw new Error(`Rows for undeclared table ${tableId}`)
        rowCounts[tableId] = await applyRows(client, spec, rows, run.id, schema)
      }
      for (const { artifact, layer, stored } of storedArtifacts) {
        await registerSnapshot(client, run.id, artifact, stored, layer.temporality, layerRowFor(artifact.layerId))
      }
      if (webhookEvents.rows.length > 0) {
        await client.query("UPDATE app.webhook_events SET run_id = $1 WHERE id = ANY($2)", [
          run.id,
          webhookEvents.rows.map(r => r.id)
        ])
      }
      await client.query(
        `UPDATE app.runs SET status = 'succeeded', finished_at = now(), state_out = $2,
           definition_version = $3, stats = $4, log = $5, inputs = $6
         WHERE id = $1`,
        [
          run.id,
          output.state !== undefined ? JSON.stringify(output.state) : null,
          definitionVersion,
          JSON.stringify({ rows: rowCounts, snapshots: storedArtifacts.length, durationMs: Date.now() - started }),
          log,
          // Lineage records the AOI the run actually executed with: the
          // deployment default resolves at run time, so the definition alone
          // cannot answer "what area did run X ingest"
          JSON.stringify({ ...(manifest ?? {}), aoi: definition.aoi ?? null })
        ]
      )
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    await finishRun(deps.pool, run.id, "failed", {
      error: err instanceof Error ? err.message : String(err),
      log: null
    })
  } finally {
    clearInterval(heartbeat)
    if (outDir) await rm(outDir, { recursive: true, force: true })
    if (inDir) await rm(inDir, { recursive: true, force: true })
  }
}

/** Writes a terminal non-success state for a run. */
async function finishRun(
  pool: pg.Pool,
  runId: string,
  status: "failed" | "timeout",
  fields: { error: string; log: string | null }
): Promise<void> {
  await pool.query(
    `UPDATE app.runs SET status = $2, finished_at = now(), error = $3, log = COALESCE($4, log)
     WHERE id = $1 AND status = 'running'`,
    [runId, status, fields.error, fields.log]
  )
}

/** Secret key or a clear error when definitions need secrets and none is configured. */
function requireKey(deps: ExecutorDeps): Buffer {
  if (!deps.secretKey) throw new Error("INTEGRATOR_SECRET_KEY is not configured")
  return deps.secretKey
}

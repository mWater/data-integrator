import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pg from "pg"
import { Runner, parseJobOutput } from "@data-integrator/runner"
import { IntegrationDefinition, RunResult } from "@data-integrator/definitions"
import { applyRows } from "./destinations.js"
import { storeArtifact, registerSnapshot } from "./catalog.js"
import { RasterStore } from "./rasterStore.js"
import { getSecrets } from "./secrets.js"

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
}

/** How often a running worker refreshes its lease. */
const HEARTBEAT_MS = 15_000

/** One row of app.runs the executor cares about. */
interface RunRow {
  id: string
  integration_id: string
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
    const candidates = await client.query(
      `SELECT id FROM app.runs WHERE status = 'queued' AND scheduled_at <= now()
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

/** Definition with deployment overrides applied (aoi, trigger, limits). */
function effectiveDefinition(definition: IntegrationDefinition, overrides: Record<string, unknown>): IntegrationDefinition {
  return { ...definition, ...overrides }
}

/**
 * Executes one claimed run to completion, implementing the commit protocol:
 * job first, files into the store next, then a single transaction for rows,
 * snapshot registration, webhook consumption, state, and the status flip.
 */
export async function executeRun(deps: ExecutorDeps, run: RunRow): Promise<void> {
  const heartbeat = setInterval(() => {
    deps.pool.query("UPDATE app.runs SET heartbeat_at = now() WHERE id = $1", [run.id]).catch(() => {})
  }, HEARTBEAT_MS)

  let outDir: string | null = null
  try {
    const integrationResult = await deps.pool.query(
      "SELECT definition, definition_hash, overrides FROM app.integrations WHERE id = $1",
      [run.integration_id]
    )
    const row = integrationResult.rows[0]
    const definition = effectiveDefinition(row.definition, row.overrides)
    if (definition.inputs && Object.keys(definition.inputs).length > 0) {
      throw new Error("Input materialization is not implemented yet")
    }

    const image = deps.images[definition.runtime]
    if (!image) throw new Error(`No image configured for runtime ${definition.runtime}`)

    const secrets = definition.secrets?.length
      ? await getSecrets(deps.pool, requireKey(deps), definition.secrets)
      : {}
    const stateResult = await deps.pool.query(
      `SELECT state_out FROM app.runs
       WHERE integration_id = $1 AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
      [run.integration_id]
    )
    const previousState = stateResult.rows[0]?.state_out ?? null
    const webhookEvents = await deps.pool.query(
      `SELECT id, payload FROM app.webhook_events
       WHERE integration_id = $1 AND run_id IS NULL ORDER BY received_at`,
      [run.integration_id]
    )

    const workDir = path.join(deps.workRoot, run.integration_id)
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
        mounts: { workDir, outDir },
        limits: definition.limits
          ? { cpus: definition.limits.cpus, memoryMb: definition.limits.memoryMb, timeoutMs: definition.limits.timeoutMs }
          : undefined
      },
      { onStderrLine: line => logParts.push(line) }
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
        stored: await storeArtifact(deps.store, outDir, artifact, layer.bands.map(b => b.id))
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
        rowCounts[tableId] = await applyRows(client, spec, rows, run.id)
      }
      for (const { artifact, layer, stored } of storedArtifacts) {
        await registerSnapshot(client, run.id, artifact, stored, layer.temporality)
      }
      if (webhookEvents.rows.length > 0) {
        await client.query("UPDATE app.webhook_events SET run_id = $1 WHERE id = ANY($2)", [
          run.id,
          webhookEvents.rows.map(r => r.id)
        ])
      }
      await client.query(
        `UPDATE app.runs SET status = 'succeeded', finished_at = now(), state_out = $2,
           definition_hash = $3, stats = $4, log = $5
         WHERE id = $1`,
        [
          run.id,
          output.state !== undefined ? JSON.stringify(output.state) : null,
          row.definition_hash,
          JSON.stringify({ rows: rowCounts, snapshots: storedArtifacts.length, durationMs: Date.now() - started }),
          log
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

import { rm } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { ExecutorDeps, executeRun, RunRow } from "./executor.js"

/**
 * Inserts one manual run of an integration directly as running, under a fresh
 * lease owned by claimedBy. Never queued, so no scheduler worker can claim it
 * first, and a refused start leaves no row behind. Refused with "already
 * queued" when a run is waiting (it is about to start anyway) and "already
 * running" when the one-running index rejects the insert.
 */
export async function insertRunningRun(pool: pg.Pool, integrationId: string, claimedBy: string): Promise<RunRow> {
  let inserted
  try {
    inserted = await pool.query(
      `INSERT INTO app.runs (integration_id, trigger, status, claimed_by, attempt, heartbeat_at, started_at)
       SELECT $1, 'manual', 'running', $2, gen_random_uuid(), now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM app.runs WHERE integration_id = $1 AND status = 'queued')
       RETURNING id, integration_id, params, attempt`,
      [integrationId, claimedBy]
    )
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new Error("A run of this integration is already running")
    }
    throw err
  }
  if (inserted.rows.length === 0) throw new Error("A run of this integration is already queued")
  return inserted.rows[0] as RunRow
}

/**
 * Starts one production run, returning its id immediately; execution
 * continues in the background of the server process. Shared by the
 * manual-run API and a design session's finish, which starts the first load
 * of a freshly installed integration. See insertRunningRun for refusals.
 */
export async function startProductionRun(deps: ExecutorDeps, integrationId: string): Promise<string> {
  await deps.runner.ensureReady()
  const run = await insertRunningRun(deps.pool, integrationId, "api")
  void executeRun(deps, run).catch(() => {
    // executeRun records its own failures; nothing useful to add here
  })
  return run.id
}

/** Starts manual runs from the HTTP API. */
export class RunService {
  private deps: ExecutorDeps

  /** Creates the service over executor deps. */
  constructor(deps: ExecutorDeps) {
    this.deps = deps
  }

  /**
   * Starts one run of an existing integration; see startProductionRun. A
   * draft (a design session that has not finished) has no certified code to
   * run and is refused.
   */
  async start(integrationId: string): Promise<string> {
    const found = await this.deps.pool.query("SELECT status FROM app.integrations WHERE id = $1", [integrationId])
    if (found.rows.length === 0) throw new Error(`Unknown integration ${integrationId}`)
    if (found.rows[0].status !== "ready") {
      throw new Error(`Integration ${integrationId} is a draft; finish its design session before running it`)
    }
    return startProductionRun(this.deps, integrationId)
  }

  /** Removes an integration's persistent /work cache; missing is fine. */
  async removeWorkDir(integrationId: string): Promise<void> {
    await rm(path.join(this.deps.workRoot, integrationId), { recursive: true, force: true })
  }
}

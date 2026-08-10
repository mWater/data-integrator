import { rm } from "node:fs/promises"
import path from "node:path"
import { ExecutorDeps, executeRun } from "./executor.js"

/**
 * Enqueues and starts one production run, returning its id immediately;
 * execution continues in the background of the server process. The
 * one-queued/one-running indexes are the concurrency guard, exactly as for CLI
 * and agent runs: throws "already queued or running" when they reject the
 * enqueue. Shared by the manual-run API and a design session's finish, which
 * starts the first load of a freshly installed integration.
 */
export async function startProductionRun(deps: ExecutorDeps, integrationId: string): Promise<string> {
  await deps.runner.ensureReady()

  let runId: string
  try {
    const inserted = await deps.pool.query(
      "INSERT INTO app.runs (integration_id, trigger, status) VALUES ($1, 'manual', 'queued') RETURNING id",
      [integrationId]
    )
    runId = inserted.rows[0].id
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new Error("A run of this integration is already queued or running")
    }
    throw err
  }
  const claimed = await deps.pool.query(
    `UPDATE app.runs SET status = 'running', claimed_by = 'api', heartbeat_at = now(), started_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id, integration_id, params`,
    [runId]
  )
  void executeRun(deps, claimed.rows[0]).catch(() => {
    // executeRun records its own failures; nothing useful to add here
  })
  return runId
}

/** Starts manual runs from the HTTP API. */
export class RunService {
  private deps: ExecutorDeps

  /** Creates the service over executor deps. */
  constructor(deps: ExecutorDeps) {
    this.deps = deps
  }

  /** Starts one run of an existing integration; see startProductionRun. */
  async start(integrationId: string): Promise<string> {
    const exists = await this.deps.pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [integrationId])
    if (exists.rows.length === 0) throw new Error(`Unknown integration ${integrationId}`)
    return startProductionRun(this.deps, integrationId)
  }

  /** Removes an integration's persistent /work cache; missing is fine. */
  async removeWorkDir(integrationId: string): Promise<void> {
    await rm(path.join(this.deps.workRoot, integrationId), { recursive: true, force: true })
  }
}

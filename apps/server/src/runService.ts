import { ExecutorDeps, executeRun } from "./executor.js"

/**
 * Starts manual runs from the HTTP API: enqueues, claims, and executes in the
 * background of the server process. The one-queued/one-running indexes are the
 * concurrency guard, exactly as for CLI and agent runs.
 */
export class RunService {
  private deps: ExecutorDeps
  private ready: Promise<void> | null = null

  /** Creates the service over executor deps. */
  constructor(deps: ExecutorDeps) {
    this.deps = deps
  }

  /**
   * Enqueues and starts one run, returning its id immediately; execution
   * continues in the background. Throws "already queued or running" when the
   * serialization indexes reject the enqueue.
   */
  async start(integrationId: string): Promise<string> {
    const exists = await this.deps.pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [integrationId])
    if (exists.rows.length === 0) throw new Error(`Unknown integration ${integrationId}`)

    this.ready ??= this.deps.runner.ensureReady()
    await this.ready

    let runId: string
    try {
      const inserted = await this.deps.pool.query(
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
    const claimed = await this.deps.pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = 'api', heartbeat_at = now(), started_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING id, integration_id, params`,
      [runId]
    )
    void executeRun(this.deps, claimed.rows[0]).catch(() => {
      // executeRun records its own failures; nothing useful to add here
    })
    return runId
  }
}

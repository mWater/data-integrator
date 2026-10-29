import { rm } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { ExecutorDeps, executeRun, RunRow } from "./executor.js"
import { missingFileSlot, resolveFiles } from "./files.js"

/** A run request the caller can fix (unknown pins, a slot awaiting its first upload): 400, not 500. */
export class RunRequestError extends Error {}

/** Where a pinned run went: started at once, or waiting its turn in the queue. */
export interface PinnedRunStart {
  /** Run id */
  runId: string
  /** running when the integration was idle, queued behind the run in progress otherwise */
  status: "running" | "queued"
}

/**
 * Inserts one manual run of an integration directly as running, under a fresh
 * lease owned by claimedBy. Never queued, so no scheduler worker can claim it
 * first, and a refused start leaves no row behind. Refused with "already
 * queued" when a run is waiting (it is about to start anyway) and "already
 * running" when the one-running index rejects the insert.
 */
export async function insertRunningRun(
  pool: pg.Pool,
  integrationId: string,
  claimedBy: string,
  filePins: Record<string, string> | null = null,
  trigger: "manual" | "rebuild" = "manual"
): Promise<RunRow> {
  let inserted
  try {
    inserted = await pool.query(
      `INSERT INTO app.runs (integration_id, trigger, status, claimed_by, attempt, heartbeat_at, started_at, file_pins)
       SELECT $1, $4, 'running', $2, gen_random_uuid(), now(), now(), $3::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM app.runs WHERE integration_id = $1 AND status = 'queued')
       RETURNING id, integration_id, trigger, attempt`,
      [integrationId, claimedBy, filePins ? JSON.stringify(filePins) : null, trigger]
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
 * of a freshly installed integration. A rebuild runs cold: an empty /work and
 * no previous state, so the code produces everything in scope again. See
 * insertRunningRun for refusals.
 */
export async function startProductionRun(
  deps: ExecutorDeps,
  integrationId: string,
  trigger: "manual" | "rebuild" = "manual"
): Promise<string> {
  await deps.runner.ensureReady()
  const run = await insertRunningRun(deps.pool, integrationId, "api", null, trigger)
  void executeRun(deps, run).catch(() => {
    // executeRun records its own failures; nothing useful to add here
  })
  return run.id
}

/**
 * Starts a run reading the given file versions (an upload, a revert, a
 * multi-slot replace, a design session's finish). The pins are validated
 * first, so a refused request leaves no row. An idle integration runs at
 * once; otherwise the run waits its turn: the pins merge into the queued run
 * when there is one (it would have read the old current versions, and the
 * caller wants these), with its start pulled to now, or a queued run is
 * created behind the one in progress.
 */
export async function startPinnedRun(
  deps: ExecutorDeps,
  integrationId: string,
  definition: IntegrationDefinition,
  pins: Record<string, string>
): Promise<PinnedRunStart> {
  try {
    await resolveFiles(deps.pool, { integrationId, definition, pins })
  } catch (err) {
    throw new RunRequestError(err instanceof Error ? err.message : String(err))
  }
  await deps.runner.ensureReady()
  try {
    const run = await insertRunningRun(deps.pool, integrationId, "api", pins)
    void executeRun(deps, run).catch(() => {
      // executeRun records its own failures; nothing useful to add here
    })
    return { runId: run.id, status: "running" }
  } catch (err) {
    if (!(err instanceof Error) || !/already (queued|running)/.test(err.message)) throw err
  }
  // The queue can change under us (a worker claims the queued run, the
  // running one finishes), so merge-or-insert retries a few times
  for (let attempt = 0; attempt < 5; attempt++) {
    const merged = await deps.pool.query(
      `UPDATE app.runs SET file_pins = COALESCE(file_pins, '{}'::jsonb) || $2::jsonb, scheduled_at = LEAST(scheduled_at, now())
       WHERE integration_id = $1 AND status = 'queued' RETURNING id`,
      [integrationId, JSON.stringify(pins)]
    )
    if (merged.rows.length > 0) return { runId: merged.rows[0].id, status: "queued" }
    const queued = await deps.pool.query(
      `INSERT INTO app.runs (integration_id, trigger, status, file_pins) VALUES ($1, 'manual', 'queued', $2::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [integrationId, JSON.stringify(pins)]
    )
    if (queued.rows.length > 0) return { runId: queued.rows[0].id, status: "queued" }
  }
  throw new Error("The run queue kept changing; try again")
}

/** Starts manual runs from the HTTP API. */
export class RunService {
  private deps: ExecutorDeps

  /** Creates the service over executor deps. */
  constructor(deps: ExecutorDeps) {
    this.deps = deps
  }

  /**
   * Starts one run of an existing integration, or a rebuild; see
   * startProductionRun. A draft (a design session that has not finished) has
   * no certified code to run and is refused.
   */
  async start(integrationId: string, trigger: "manual" | "rebuild" = "manual"): Promise<string> {
    const definition = await this.readyDefinition(integrationId)
    // Refused before any row exists: a run with nothing to read would only fail
    const missing = await missingFileSlot(this.deps.pool, integrationId, definition)
    if (missing) throw new RunRequestError(`Awaiting file upload for slot ${missing}`)
    return startProductionRun(this.deps, integrationId, trigger)
  }

  /** Starts (or queues) one run of an existing integration pinning file versions; see startPinnedRun. */
  async startPinned(integrationId: string, pins: Record<string, string>): Promise<PinnedRunStart> {
    const definition = await this.readyDefinition(integrationId)
    return startPinnedRun(this.deps, integrationId, definition, pins)
  }

  /** The installed definition of a runnable integration; drafts and unknown ids are refused. */
  private async readyDefinition(integrationId: string): Promise<IntegrationDefinition> {
    const found = await this.deps.pool.query("SELECT status, definition FROM app.integrations WHERE id = $1", [
      integrationId
    ])
    if (found.rows.length === 0) throw new Error(`Unknown integration ${integrationId}`)
    if (found.rows[0].status !== "ready") {
      throw new Error(`Integration ${integrationId} is a draft; finish its design session before running it`)
    }
    return found.rows[0].definition as IntegrationDefinition
  }

  /** Removes an integration's persistent /work cache; missing is fine. */
  async removeWorkDir(integrationId: string): Promise<void> {
    await rm(path.join(this.deps.workRoot, integrationId), { recursive: true, force: true })
  }
}

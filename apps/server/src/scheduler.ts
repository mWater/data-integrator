/**
 * The scheduler: turns trigger.cron into queued runs and drains the queue.
 * Three loops, all stoppable:
 *
 * - Enqueue tick: once per UTC minute, insert a queued run for every enabled,
 *   ready integration whose cron matches. The one-queued partial index makes
 *   the insert idempotent (ON CONFLICT DO NOTHING), so restarts and multiple
 *   servers cannot double-enqueue. A minute missed while the process is down
 *   is skipped by design: incremental integrations catch up from previousState
 *   on their next run.
 * - Workers: claim queued runs (FOR UPDATE SKIP LOCKED inside claimNextRun)
 *   and execute them; per-integration serialization is the partial unique
 *   indexes' job, not the workers'.
 * - Reaper: periodically fails runs with stale heartbeats, releasing the
 *   one-running constraint so the next tick can re-enqueue, and drops staging
 *   tables those runs left behind.
 */

import { hostname } from "node:os"
import { dropOrphanStagedTables } from "./destinations.js"
import { claimNextRun, executeRun, ExecutorDeps, reapStaleRuns, RUN_LABEL } from "./executor.js"
import { TileRenderer } from "./tiles.js"
import { cronMatches, parseCron } from "./cron.js"

/** Scheduler tuning; defaults suit a single-server deployment. */
export interface SchedulerOptions {
  /** Enqueue-check cadence; must divide a minute reasonably (default 20s) */
  tickMs?: number
  /** Stale-run reap cadence (default 60s) */
  reapMs?: number
  /** Concurrent run executors (default 2) */
  workers?: number
  /** Tile renderer whose cache the maintenance tick keeps within tileCacheMb */
  tiles?: TileRenderer
  /** Tile + basemap cache budget in MB; absent or 0 skips eviction */
  tileCacheMb?: number
}

/** A running scheduler; stop() resolves once all loops have wound down. */
export interface Scheduler {
  stop(): Promise<void>
}

/**
 * Enqueues a cron run for every enabled, ready integration whose cron
 * matches the given instant. Exported for tests; the loop calls it once per
 * minute. Invalid crons are skipped (validateDefinition rejects them at
 * install, so they can only predate that check).
 */
export async function enqueueDueRuns(deps: Pick<ExecutorDeps, "pool">, now: Date): Promise<number> {
  const result = await deps.pool.query(
    `SELECT id, definition->'trigger'->>'cron' AS cron FROM app.integrations
     WHERE enabled AND status = 'ready' AND definition->'trigger'->>'cron' IS NOT NULL`
  )
  let enqueued = 0
  for (const row of result.rows) {
    let due: boolean
    try {
      due = cronMatches(parseCron(row.cron), now)
    } catch {
      continue
    }
    if (!due) continue
    const inserted = await deps.pool.query(
      `INSERT INTO app.runs (integration_id, trigger, status) VALUES ($1, 'cron', 'queued')
       ON CONFLICT DO NOTHING RETURNING id`,
      [row.id]
    )
    enqueued += inserted.rows.length
  }
  return enqueued
}

/** Starts the scheduler loops over executor deps. */
export function startScheduler(deps: ExecutorDeps, options: SchedulerOptions = {}): Scheduler {
  const tickMs = options.tickMs ?? 20_000
  const reapMs = options.reapMs ?? 60_000
  const workers = options.workers ?? 2

  // Job containers left by a previous process have no owner to commit them
  // and would only ever race a replacement, so they go before any claim
  const swept = deps.runner
    .killLabelled(RUN_LABEL)
    .then(n => {
      if (n > 0) console.log(`scheduler: removed ${n} orphaned job container(s)`)
    })
    .catch(err => console.error("scheduler orphan sweep failed:", err))

  let stopped = false
  const sleepers = new Set<() => void>()
  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        sleepers.delete(wake)
        resolve()
      }, ms)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      sleepers.add(wake)
    })

  // Enqueue once per distinct UTC minute, regardless of tick alignment
  let lastMinute = ""
  const enqueueLoop = (async () => {
    while (!stopped) {
      const now = new Date()
      const minute = now.toISOString().slice(0, 16)
      if (minute !== lastMinute) {
        lastMinute = minute
        await enqueueDueRuns(deps, now).catch(err => console.error("scheduler enqueue failed:", err))
      }
      await sleep(tickMs)
    }
  })()

  const workerLoops = Array.from({ length: workers }, (_, i) =>
    (async () => {
      const workerId = `scheduler-${hostname()}-${i}`
      await swept
      while (!stopped) {
        let run = null
        try {
          run = await claimNextRun(deps.pool, workerId)
        } catch (err) {
          console.error("scheduler claim failed:", err)
        }
        if (run) await executeRun(deps, run)
        else await sleep(tickMs)
      }
    })()
  )

  const reapLoop = (async () => {
    while (!stopped) {
      await sleep(reapMs)
      if (stopped) break
      await reapStaleRuns(deps.pool).catch(err => console.error("scheduler reap failed:", err))
      await dropOrphanStagedTables(deps.pool).catch(err => console.error("staging cleanup failed:", err))
      if (options.tiles && options.tileCacheMb) {
        await options.tiles
          .evictToBudget(options.tileCacheMb)
          .then(evicted => {
            if (evicted > 0) console.log(`tile cache: evicted ${evicted} files to stay under ${options.tileCacheMb} MB`)
          })
          .catch(err => console.error("tile cache eviction failed:", err))
      }
    }
  })()

  return {
    async stop() {
      stopped = true
      for (const wake of [...sleepers]) wake()
      await Promise.all([enqueueLoop, reapLoop, ...workerLoops])
    }
  }
}

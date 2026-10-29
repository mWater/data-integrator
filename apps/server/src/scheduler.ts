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
 * - Workers: claim queued runs (claimNextRun: a conditional UPDATE per candidate)
 *   and execute them; per-integration serialization is the partial unique
 *   indexes' job, not the workers'.
 * - Reaper: periodically fails runs with stale heartbeats, releasing the
 *   one-running constraint so the next tick can re-enqueue, and drops staging
 *   tables those runs left behind.
 *
 * Snapshot retention (superseded and expired raster snapshots) sweeps after
 * every run a worker finishes and hourly from the reaper, so paused
 * integrations still age out.
 */

import { hostname } from "node:os"
import { advanceCurrentPointers } from "./catalog.js"
import { dropOrphanStagedTables } from "./destinations.js"
import { claimNextRun, executeRun, ExecutorDeps, reapStaleRuns, RUN_LABEL } from "./executor.js"
import { pruneSnapshots } from "./retention.js"
import { sweepHousekeeping } from "./housekeeping.js"
import { TileRenderer } from "./tiles.js"
import { cronMatches, parseCron } from "./cron.js"
import { missingFileSlot } from "./files.js"
import { IntegrationDefinition } from "@data-integrator/definitions"

/** How often the reaper runs the retention sweep when no run has triggered one. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** How often the reaper runs housekeeping (housekeeping.ts). */
const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000

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
 * minute. Invalid crons are skipped defensively (validateDefinition
 * rejects them at install), and so are integrations
 * with a file slot that has never been filled: a run would only fail.
 */
export async function enqueueDueRuns(deps: Pick<ExecutorDeps, "pool">, now: Date): Promise<number> {
  const result = await deps.pool.query(
    `SELECT id, definition->'trigger'->>'cron' AS cron, definition->'files' AS files FROM app.integrations
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
    if (row.files && (await missingFileSlot(deps.pool, row.id, { files: row.files } as IntegrationDefinition))) continue
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

  // One retention sweep at a time; workers finishing together share it
  let pruning: Promise<void> | null = null
  let lastPrune = 0
  // Housekeeping first runs one reap interval after start, then daily
  let lastHousekeeping = 0
  const prune = () => {
    pruning ??= pruneSnapshots(deps.pool, deps.store, options.tiles)
      .then(r => {
        if (r.snapshots > 0) {
          console.log(`retention: deleted ${r.snapshots} raster snapshot(s), ${r.superseded} of them superseded`)
        }
      })
      .catch(err => console.error("retention sweep failed:", err))
      .finally(() => {
        lastPrune = Date.now()
        pruning = null
      })
    return pruning
  }

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
        if (run) {
          await executeRun(deps, run)
          await prune()
        } else await sleep(tickMs)
      }
    })()
  )

  const reapLoop = (async () => {
    while (!stopped) {
      await sleep(reapMs)
      if (stopped) break
      await reapStaleRuns(deps.pool).catch(err => console.error("scheduler reap failed:", err))
      await dropOrphanStagedTables(deps.pool).catch(err => console.error("staging cleanup failed:", err))
      await advanceCurrentPointers(deps.pool).catch(err => console.error("current snapshot sweep failed:", err))
      if (Date.now() - lastPrune >= PRUNE_INTERVAL_MS) await prune()
      if (Date.now() - lastHousekeeping >= HOUSEKEEPING_INTERVAL_MS) {
        lastHousekeeping = Date.now()
        await sweepHousekeeping(deps.pool, deps.store, deps.workRoot)
          .then(r => {
            const removed = Object.entries(r).filter(([, n]) => n > 0)
            if (removed.length > 0) console.log(`housekeeping: ${removed.map(([k, n]) => `${k} ${n}`).join(", ")}`)
          })
          .catch(err => console.error("housekeeping failed:", err))
      }
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

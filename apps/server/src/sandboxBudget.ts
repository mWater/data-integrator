/**
 * Host-wide memory budget for job sandboxes. Every path that launches a job
 * (scheduler workers, design sessions) takes a reservation sized by the job's
 * memory limit before starting the container, so the sum of admitted limits
 * never exceeds what the host can back. Without it, a few open design
 * sessions can each hold a sandbox worth half the machine and the kernel's
 * OOM killer takes the whole box down with them.
 */
export class SandboxBudget {
  private readonly budgetMb: number
  private inUse = 0
  private waiters: { mb: number; admit: () => void }[] = []

  /** @param budgetMb - Total sandbox memory the host may commit at once */
  constructor(budgetMb: number) {
    this.budgetMb = Math.max(1, Math.floor(budgetMb))
  }

  /** Memory reserved by admitted jobs right now, in MB. */
  get inUseMb(): number {
    return this.inUse
  }

  /** Jobs waiting for a reservation. */
  get queued(): number {
    return this.waiters.length
  }

  /** Total budget in MB. */
  get totalMb(): number {
    return this.budgetMb
  }

  /**
   * Reserves memory for one job, waiting in FIFO order until it fits.
   * A job larger than the whole budget is admitted once nothing else runs,
   * so an oversized limit degrades to "alone on the host" rather than never.
   * Resolves to the release function; call it exactly once when the job ends.
   * @param mb - The job's memory limit
   * @param onWait - Called once if the job has to queue, with the reason
   */
  acquire(mb: number, onWait?: (reason: string) => void): Promise<() => void> {
    const need = Math.max(1, Math.floor(mb))
    return new Promise(resolve => {
      const admit = () => {
        this.inUse += need
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.inUse -= need
          this.drain()
        })
      }
      if (this.waiters.length === 0 && this.fits(need)) {
        admit()
        return
      }
      onWait?.(
        `Waiting for sandbox memory: ${need} MB requested, ${this.inUse} MB of ${this.budgetMb} MB in use, ${this.waiters.length} ahead`
      )
      this.waiters.push({ mb: need, admit })
    })
  }

  /** Whether a job of this size can start now. */
  private fits(mb: number): boolean {
    return this.inUse + mb <= this.budgetMb || this.inUse === 0
  }

  /** Admits queued jobs from the front while they fit. */
  private drain(): void {
    while (this.waiters.length > 0 && this.fits(this.waiters[0].mb)) {
      this.waiters.shift()!.admit()
    }
  }
}

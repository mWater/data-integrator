import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRuleset } from "./egress.js"
import { JobLimits, JobResult, JobSpec, RunHooks, RunnerOptions } from "./types.js"

const execFileP = promisify(execFile)

/** Runner option defaults. */
const DEFAULTS = {
  runscPath: "/usr/local/bin/runsc" as string | null,
  podmanPath: "podman",
  network: "integrator-jobs",
  egress: "public-only" as const,
  stdoutLimitBytes: 10 * 1024 * 1024,
  stderrLimitBytes: 256 * 1024,
  dns: ["1.1.1.1", "9.9.9.9"],
  blockedAddresses: [] as string[],
  diskMonitorMs: 30_000,
  scopeOverheadMb: 256
}

/** Per-job limit defaults, used when JobSpec.limits omits a value. */
const LIMIT_DEFAULTS = {
  cpus: 2,
  memoryMb: 2048,
  timeoutMs: 15 * 60 * 1000,
  pidsMax: 256,
  tmpfsMb: 256
}

/** Keeps the rootless infra netns alive between jobs so egress rules persist. */
const KEEPER_IMAGE = "docker.io/library/alpine:3.20"

/** Threads and processes allowed in a job's scope beyond JobLimits.pidsMax, for podman, conmon and gVisor */
const SCOPE_TASKS_OVERHEAD = 256

/** How long to wait for podman to move into its own systemd scope */
const SCOPE_WAIT_MS = 10_000

/**
 * Payload-opaque job executor over rootless podman + gVisor.
 * Owns sandboxing, limits, mounts, and the egress policy. Knows nothing about
 * integrations, queues, or destinations; those live in the server.
 */
export class Runner {
  /** Resolved options with defaults applied */
  private opts: Required<RunnerOptions>

  /** Serializes network preparation, so concurrent jobs never race to recreate the keeper */
  private networkLock: Promise<void> = Promise.resolve()

  /** Creates a runner; unspecified options fall back to DEFAULTS. */
  constructor(options?: RunnerOptions) {
    const merged = { ...DEFAULTS, ...options }
    this.opts = {
      ...merged,
      resourceControl: options?.resourceControl ?? (merged.runscPath ? "systemd-scope" : "podman")
    } as Required<RunnerOptions>
  }

  /** Verifies the stack and prepares network, keeper, and egress rules. Idempotent. */
  async ensureReady(): Promise<void> {
    await this.podman(["--version"])
    if (this.opts.runscPath) {
      await access(this.opts.runscPath)
    }

    if (!(await this.podmanOk(["network", "exists", this.opts.network]))) {
      await this.podman(["network", "create", this.opts.network])
    }

    const keeper = `${this.opts.network}-keeper`
    // A keeper can survive host changes that invalidate it (its recorded OCI
    // runtime uninstalled, its image pruned); recreate rather than wedge
    if (await this.podmanOk(["container", "exists", keeper])) {
      if (await this.podmanOk(["start", keeper])) return this.ensureEgress()
      await this.podmanOk(["rm", "-f", keeper])
    }
    await this.podman([
      "run", "-d", "--name", keeper, "--network", this.opts.network,
      KEEPER_IMAGE, "sleep", "infinity"
    ])
    await this.ensureEgress()
  }

  /**
   * Re-verifies the job network before a launch: restarts the keeper (or
   * rebuilds it) and re-applies the egress rules. A keeper that died while
   * idle takes the netns and its drop rules with it, and the next job would
   * otherwise get a fresh netns with open egress.
   */
  private prepareNetwork(): Promise<void> {
    const next = this.networkLock.then(async () => {
      const keeper = `${this.opts.network}-keeper`
      if (await this.podmanOk(["start", keeper])) await this.ensureEgress()
      else await this.ensureReady()
    })
    this.networkLock = next.catch(() => {})
    return next
  }

  /** Applies the egress policy when configured. */
  private async ensureEgress(): Promise<void> {
    if (this.opts.egress === "public-only") {
      await this.applyEgressRules()
    }
  }

  /** Removes the keeper container and job network. */
  async teardown(): Promise<void> {
    const keeper = `${this.opts.network}-keeper`
    await this.podmanOk(["rm", "-f", keeper])
    await this.podmanOk(["network", "rm", "-f", this.opts.network])
  }

  /**
   * Runs a single job to completion. The payload goes to stdin; stdout is the
   * result channel; stderr streams to hooks and is kept as a capped tail.
   */
  async run(spec: JobSpec, hooks?: RunHooks): Promise<JobResult> {
    const limits: Required<Omit<JobLimits, "workDiskMb">> & Pick<JobLimits, "workDiskMb"> = {
      ...LIMIT_DEFAULTS,
      ...Object.fromEntries(Object.entries(spec.limits ?? {}).filter(([, v]) => v !== undefined))
    }
    const name = `job-${randomUUID().slice(0, 8)}`
    const args = ["run", "--rm", "-i", "--name", name]

    // Fails closed: a job is never launched onto a network whose rules are unverified
    if (spec.network !== false) await this.prepareNetwork()

    if (this.opts.runscPath) {
      args.push("--runtime", this.opts.runscPath, "--runtime-flag=ignore-cgroups")
    }
    args.push(spec.network === false ? "--network=none" : `--network=${this.opts.network}`)
    if (spec.network !== false) {
      for (const server of this.opts.dns) args.push("--dns", server)
    }
    args.push(
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--tmpfs", `/tmp:rw,size=${limits.tmpfsMb}m`,
      "--cpus", String(limits.cpus),
      "-m", `${limits.memoryMb}m`,
      "--pids-limit", String(limits.pidsMax),
      // podman-side hard kill as backstop to our own timer
      "--timeout", String(Math.ceil(limits.timeoutMs / 1000) + 10)
    )

    if (spec.mounts?.inDir) args.push("-v", `${spec.mounts.inDir}:/in:ro`)
    if (spec.mounts?.workDir) args.push("-v", `${spec.mounts.workDir}:/work`)
    if (spec.mounts?.outDir) args.push("-v", `${spec.mounts.outDir}:/out`)
    for (const mount of spec.mounts?.readOnly ?? []) {
      args.push("-v", `${mount.hostPath}:${mount.containerPath}:ro`)
    }

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push("-e", `${key}=${value}`)
    }
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
      args.push("--label", `${key}=${value}`)
    }

    args.push(spec.image, ...(spec.command ?? []))

    const started = Date.now()
    const child = spawn(this.opts.podmanPath, args, { stdio: ["pipe", "pipe", "pipe"] })

    child.stdin.on("error", () => {}) // job may exit without reading stdin

    let stdout = ""
    let stdoutTruncated = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < this.opts.stdoutLimitBytes) {
        stdout += chunk.toString("utf8")
        if (stdout.length > this.opts.stdoutLimitBytes) {
          stdout = stdout.slice(0, this.opts.stdoutLimitBytes)
          stdoutTruncated = true
        }
      } else {
        stdoutTruncated = true
      }
    })

    let stderrTail = ""
    let lineBuffer = ""
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stderrTail = (stderrTail + text).slice(-this.opts.stderrLimitBytes)
      if (hooks?.onStderrLine) {
        lineBuffer += text
        const lines = lineBuffer.split("\n")
        lineBuffer = lines.pop() ?? ""
        for (const line of lines) hooks.onStderrLine(line)
      }
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // --rm cleans up; rm -f both stops and removes if podman outlives the child
      execFile(this.opts.podmanPath, ["rm", "-f", name], () => {})
    }, limits.timeoutMs)

    let abortedReason: string | null = null
    const handle = {
      abort: (reason: string) => {
        if (abortedReason !== null || timedOut) return
        abortedReason = reason
        execFile(this.opts.podmanPath, ["rm", "-f", name], () => {})
      }
    }
    hooks?.onStart?.(handle)

    // The harness blocks on stdin, so job code cannot run before the payload
    // is written: cap the scope first, and never write it if that fails
    if (this.opts.resourceControl === "systemd-scope" && child.pid !== undefined) {
      try {
        await capPodmanScope(child.pid, {
          memoryMb: limits.memoryMb + this.opts.scopeOverheadMb,
          cpus: limits.cpus,
          tasksMax: limits.pidsMax + SCOPE_TASKS_OVERHEAD
        })
      } catch (err) {
        handle.abort(`resource limits could not be applied: ${(err as Error).message}`)
        child.kill("SIGKILL")
      }
    }
    if (abortedReason === null) child.stdin.write(JSON.stringify(spec.payload ?? null))
    child.stdin.end()

    // Disk guard: /work is a bind mount, so no kernel limit applies; poll its
    // usage and kill the job when it crosses the quota
    let diskTimer: ReturnType<typeof setInterval> | null = null
    const workDir = spec.mounts?.workDir
    if (workDir && limits.workDiskMb !== undefined) {
      const quotaMb = limits.workDiskMb
      let checking = false
      diskTimer = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          const usedMb = await dirUsageMb(workDir)
          if (usedMb !== null && usedMb > quotaMb) {
            handle.abort(`/work reached ${usedMb} MB, over the ${quotaMb} MB quota`)
          }
        } finally {
          checking = false
        }
      }, this.opts.diskMonitorMs)
    }

    const exitCode = await new Promise<number | null>(resolve => {
      child.on("close", code => resolve(code))
      child.on("error", () => resolve(null))
    })
    clearTimeout(timer)
    if (diskTimer !== null) clearInterval(diskTimer)
    if (lineBuffer && hooks?.onStderrLine) hooks.onStderrLine(lineBuffer)

    return {
      status: timedOut ? "timeout" : abortedReason !== null ? "failed" : exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      stdout,
      stdoutTruncated,
      stdoutLimitBytes: this.opts.stdoutLimitBytes,
      stderrTail,
      durationMs: Date.now() - started,
      ...(abortedReason !== null ? { abortedReason } : {})
    }
  }

  /**
   * Kills every job container carrying the label, or the label with the given
   * value. Called at startup to remove containers a previous process left
   * running, since a job whose owner is gone can only ever commit twice.
   * Returns the number of containers removed.
   */
  async killLabelled(key: string, value?: string): Promise<number> {
    const filter = value === undefined ? `label=${key}` : `label=${key}=${value}`
    const listed = await this.podman(["ps", "-a", "-q", "--filter", filter])
    const ids = listed.split("\n").filter(id => id.length > 0)
    for (const id of ids) await this.podmanOk(["rm", "-f", id])
    return ids.length
  }

  /** Applies the egress ruleset inside the rootless infra netns. Idempotent. */
  private async applyEgressRules(): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "integrator-egress-"))
    const file = path.join(dir, "egress.nft")
    try {
      await writeFile(file, buildRuleset(this.opts.blockedAddresses))
      await this.podman(["unshare", "--rootless-netns", "nft", "-f", file])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Runs a podman command, returning trimmed stdout; throws on nonzero exit. */
  private async podman(args: string[]): Promise<string> {
    const { stdout } = await execFileP(this.opts.podmanPath, args)
    return stdout.trim()
  }

  /** Runs a podman command, returning whether it exited zero. */
  private async podmanOk(args: string[]): Promise<boolean> {
    try {
      await execFileP(this.opts.podmanPath, args)
      return true
    } catch {
      return false
    }
  }
}

/** Ceilings applied to a job's systemd scope. */
interface ScopeLimits {
  /** MemoryMax in MB; swap is disabled */
  memoryMb: number
  /** CPU cores, as CPUQuota */
  cpus: number
  /** TasksMax */
  tasksMax: number
}

/**
 * Caps the transient scope rootless podman moves itself into
 * (`podman-<pid>.scope`), which also holds conmon and the gVisor sandbox.
 * Waits for podman to make the move; refuses any other cgroup, since capping
 * the caller's own unit would limit the caller instead of the job.
 */
async function capPodmanScope(pid: number, limits: ScopeLimits): Promise<void> {
  const unit = `podman-${pid}.scope`
  const deadline = Date.now() + SCOPE_WAIT_MS
  let cgroup = ""
  for (;;) {
    try {
      cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim().split("\n").pop() ?? ""
    } catch {
      throw new Error("podman exited before its scope could be capped")
    }
    if (cgroup.endsWith(`/${unit}`)) break
    if (Date.now() > deadline) throw new Error(`podman did not move into ${unit} (cgroup ${cgroup})`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await execFileP("systemctl", [
    "--user", "set-property", "--runtime", unit,
    `MemoryMax=${Math.round(limits.memoryMb)}M`,
    "MemorySwapMax=0",
    `CPUQuota=${Math.round(limits.cpus * 100)}%`,
    `TasksMax=${limits.tasksMax}`
  ])
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

/** Byte count as MB or KB, for limit messages. */
function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`
}

/** Parses the stdout of a succeeded job as the harness result JSON. */
export function parseJobOutput<T = unknown>(result: JobResult): T {
  if (result.status !== "succeeded") {
    throw new Error(`Job ${result.status}: ${result.stderrTail.slice(-500)}`)
  }
  // Truncated stdout is invalid JSON in any case; reported as the size problem it is
  if (result.stdoutTruncated) {
    throw new Error(
      `Job result exceeded the ${sizeLabel(result.stdoutLimitBytes)} stdout limit. ` +
        `Write large tables to /out as files and declare them in tables[] instead of returning rows in data.`
    )
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(`Job stdout is not valid JSON: ${result.stdout.slice(0, 200)}`)
  }
}

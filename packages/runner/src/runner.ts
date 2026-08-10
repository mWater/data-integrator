import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRuleset } from "./egress.js"
import { JobResult, JobSpec, RunHooks, RunnerOptions } from "./types.js"

const execFileP = promisify(execFile)

/** Runner option defaults. */
const DEFAULTS = {
  runscPath: "/usr/local/bin/runsc" as string | null,
  podmanPath: "podman",
  network: "integrator-jobs",
  egress: "public-only" as const,
  stdoutLimitBytes: 10 * 1024 * 1024,
  stderrLimitBytes: 256 * 1024,
  dns: ["1.1.1.1", "9.9.9.9"]
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

/**
 * Payload-opaque job executor over rootless podman + gVisor.
 * Owns sandboxing, limits, mounts, and the egress policy. Knows nothing about
 * integrations, queues, or destinations; those live in the server.
 */
export class Runner {
  /** Resolved options with defaults applied */
  private opts: Required<RunnerOptions>

  /** Creates a runner; unspecified options fall back to DEFAULTS. */
  constructor(options?: RunnerOptions) {
    this.opts = { ...DEFAULTS, ...options } as Required<RunnerOptions>
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
    if (await this.podmanOk(["container", "exists", keeper])) {
      await this.podman(["start", keeper])
    } else {
      await this.podman([
        "run", "-d", "--name", keeper, "--network", this.opts.network,
        KEEPER_IMAGE, "sleep", "infinity"
      ])
    }

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
    const limits = {
      ...LIMIT_DEFAULTS,
      ...Object.fromEntries(Object.entries(spec.limits ?? {}).filter(([, v]) => v !== undefined))
    }
    const name = `job-${randomUUID().slice(0, 8)}`
    const args = ["run", "--rm", "-i", "--name", name]

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

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push("-e", `${key}=${value}`)
    }

    args.push(spec.image, ...(spec.command ?? []))

    const started = Date.now()
    const child = spawn(this.opts.podmanPath, args, { stdio: ["pipe", "pipe", "pipe"] })

    child.stdin.on("error", () => {}) // job may exit without reading stdin
    child.stdin.write(JSON.stringify(spec.payload ?? null))
    child.stdin.end()

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

    const exitCode = await new Promise<number | null>(resolve => {
      child.on("close", code => resolve(code))
      child.on("error", () => resolve(null))
    })
    clearTimeout(timer)
    if (lineBuffer && hooks?.onStderrLine) hooks.onStderrLine(lineBuffer)

    return {
      status: timedOut ? "timeout" : exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      stdout,
      stdoutTruncated,
      stdoutLimitBytes: this.opts.stdoutLimitBytes,
      stderrTail,
      durationMs: Date.now() - started
    }
  }

  /** Applies the egress ruleset inside the rootless infra netns. Idempotent. */
  private async applyEgressRules(): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "integrator-egress-"))
    const file = path.join(dir, "egress.nft")
    try {
      await writeFile(file, buildRuleset())
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

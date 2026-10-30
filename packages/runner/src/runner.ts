import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildMeterAttach, buildMeterDetach, buildMeterTable, buildRuleset, METER_TABLE } from "./egress.js"
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
export const LIMIT_DEFAULTS = {
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

/** How long to wait for podman to move into its own systemd scope, or for a job container to get its address */
const SCOPE_WAIT_MS = 10_000

/** How long to wait for a scope's cgroup files to show the limits systemd was asked to set */
const SCOPE_VERIFY_MS = 3_000

/** Where cgroup v2 is mounted */
const CGROUP_ROOT = "/sys/fs/cgroup"

/** A job's attached network meter. */
interface Meter {
  /** Suffix of the meter's nft objects */
  id: string
  /** Job container address the meter routes */
  address: string
  /** Quota in MB, when one applies */
  quotaMb?: number
}

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

  /**
   * Verifies the stack and prepares network, keeper, and egress rules. Also
   * removes meters whose job container is gone (left by a crashed process).
   * Idempotent, and safe while other processes run jobs on the same network.
   */
  async ensureReady(): Promise<void> {
    await this.withNetworkLock(() => this.prepareStack(true))
  }

  /** Brings up network, keeper and rules; sweepMeters also removes meters of vanished jobs. */
  private async prepareStack(sweepMeters: boolean): Promise<void> {
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
      if (await this.podmanOk(["start", keeper])) return this.ensureNetworkState(sweepMeters)
      await this.podmanOk(["rm", "-f", keeper])
    }
    await this.podman([
      "run", "-d", "--name", keeper, "--network", this.opts.network,
      KEEPER_IMAGE, "sleep", "infinity"
    ])
    await this.ensureNetworkState(sweepMeters)
  }

  /**
   * Re-verifies the job network before a launch: restarts the keeper (or
   * rebuilds it) and re-applies the egress rules. A keeper that died while
   * idle takes the netns and its drop rules with it, and the next job would
   * otherwise get a fresh netns with open egress.
   */
  private prepareNetwork(): Promise<void> {
    return this.withNetworkLock(async () => {
      const keeper = `${this.opts.network}-keeper`
      if (await this.podmanOk(["start", keeper])) await this.ensureNetworkState(false)
      else await this.prepareStack(false)
    })
  }

  /** Runs network changes one at a time across this runner's concurrent jobs. */
  private withNetworkLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.networkLock.then(fn)
    this.networkLock = next.then(() => {}, () => {})
    return next
  }

  /** Brings the netns to its required state: bridge MAC pinned, egress policy and meter applied. */
  private async ensureNetworkState(sweepMeters: boolean): Promise<void> {
    await this.pinBridgeMac()
    await this.ensureEgress(sweepMeters)
  }

  /**
   * Pins the job bridge's MAC address to its current value. A Linux bridge
   * without an assigned MAC takes the lowest MAC among its ports, so it changes
   * as job containers join and leave, and running containers keep sending to
   * the old gateway MAC until their neighbour entry expires: their network
   * goes dark for seconds at a time, often for a whole job. netavark 1.4
   * (Ubuntu 24.04) leaves the MAC unassigned; assigning it, even unchanged,
   * stops it following the ports.
   */
  private async pinBridgeMac(): Promise<void> {
    const bridge = (await this.podman(["network", "inspect", "--format", "{{.NetworkInterface}}", this.opts.network])).trim()
    if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) throw new Error(`Unexpected bridge name for ${this.opts.network}: ${bridge}`)
    const links = JSON.parse(await this.podman(["unshare", "--rootless-netns", "ip", "-j", "link", "show", "dev", bridge])) as {
      address?: string
    }[]
    const mac = links[0]?.address ?? ""
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new Error(`Bridge ${bridge} has no MAC address`)
    await this.podman(["unshare", "--rootless-netns", "ip", "link", "set", "dev", bridge, "address", mac])
  }

  /**
   * Applies the egress policy and the traffic meter table when configured. The
   * meter table is created once per netns, since re-creating it would drop
   * running jobs' meters.
   */
  private async ensureEgress(sweepMeters: boolean): Promise<void> {
    if (this.opts.egress === "public-only") {
      await this.applyEgressRules()
      if (!(await this.podmanOk(["unshare", "--rootless-netns", "nft", "list", "table", "inet", METER_TABLE]))) {
        await this.nftScript(buildMeterTable())
      } else if (sweepMeters) {
        await this.sweepMeters()
      }
    }
  }

  /** Removes meters whose job container no longer exists. Failures leave them for the next sweep. */
  private async sweepMeters(): Promise<void> {
    const listed = JSON.parse(
      await this.podman(["unshare", "--rootless-netns", "nft", "-j", "list", "table", "inet", METER_TABLE])
    ) as { nftables: { chain?: { name: string }; quota?: { name: string } }[] }
    const quotas = new Set(listed.nftables.flatMap(entry => (entry.quota ? [entry.quota.name] : [])))
    const elems = await this.meterElements()
    for (const entry of listed.nftables) {
      const chain = entry.chain?.name
      if (!chain?.startsWith("j_")) continue
      const id = chain.slice(2)
      const container = id.replace(/^job_/, "job-")
      if (await this.podmanOk(["container", "exists", container])) continue
      const address = Object.keys(elems).find(key => elems[key] === chain) ?? null
      try {
        await this.nftScript(buildMeterDetach(id, address ?? "", address !== null, quotas.has(`q_${id}`)))
      } catch {
        // Retried on the next sweep
      }
    }
  }

  /**
   * Meters a starting job's traffic, with an optional quota. Waits for the
   * container's address on the job network, then routes it to a fresh counter.
   */
  private async attachMeter(name: string, quotaMb: number | undefined, exited: () => boolean): Promise<Meter> {
    const deadline = Date.now() + SCOPE_WAIT_MS
    let address = ""
    for (;;) {
      try {
        const networks = JSON.parse(
          await this.podman(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name])
        ) as Record<string, { IPAddress?: string }>
        address = networks[this.opts.network]?.IPAddress ?? ""
      } catch {
        // Not created yet
      }
      if (address) break
      if (exited()) throw new Error("job exited before it could be metered")
      if (Date.now() > deadline) throw new Error(`job container ${name} has no address on ${this.opts.network}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const meter: Meter = { id: name.replace(/[^a-z0-9]/g, "_"), address, quotaMb }
    await this.withNetworkLock(async () => {
      const replace = (await this.meterElementTarget(address)) !== null
      await this.nftScript(buildMeterAttach(meter.id, address, quotaMb, replace))
    })
    return meter
  }

  /** Bytes counted so far by a job's meter. */
  private async meterBytes(meter: Meter): Promise<number> {
    const listed = JSON.parse(
      await this.podman(["unshare", "--rootless-netns", "nft", "-j", "list", "counter", "inet", METER_TABLE, `c_${meter.id}`])
    ) as { nftables: { counter?: { bytes: number } }[] }
    const counter = listed.nftables.find(entry => entry.counter)?.counter
    if (!counter) throw new Error(`meter c_${meter.id} not found`)
    return counter.bytes
  }

  /** Removes a finished job's meter, returning its byte count. */
  private async detachMeter(meter: Meter): Promise<number> {
    return this.withNetworkLock(async () => {
      const bytes = await this.meterBytes(meter)
      // The address may already belong to a newer job, whose element stays
      const ownsElement = (await this.meterElementTarget(meter.address)) === `j_${meter.id}`
      await this.nftScript(buildMeterDetach(meter.id, meter.address, ownsElement, meter.quotaMb !== undefined))
      return bytes
    })
  }

  /** Chain the meter map currently routes an address to, or null when it has no element. */
  private async meterElementTarget(address: string): Promise<string | null> {
    const elems = await this.meterElements()
    return address in elems ? elems[address] : null
  }

  /** Meter map elements: job container address to the chain it routes to. */
  private async meterElements(): Promise<Record<string, string>> {
    const listed = JSON.parse(
      await this.podman(["unshare", "--rootless-netns", "nft", "-j", "list", "map", "inet", METER_TABLE, "jobs4"])
    ) as { nftables: { map?: { elem?: [string, { jump?: { target: string } }][] } }[] }
    const elems = listed.nftables.find(entry => entry.map)?.map?.elem ?? []
    return Object.fromEntries(elems.map(([key, value]) => [key, value.jump?.target ?? ""]))
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
    const limits: Required<Omit<JobLimits, "workDiskMb" | "tmpDiskMb" | "egressMb">> & Pick<JobLimits, "workDiskMb" | "tmpDiskMb" | "egressMb"> = {
      ...LIMIT_DEFAULTS,
      ...Object.fromEntries(Object.entries(spec.limits ?? {}).filter(([, v]) => v !== undefined))
    }
    const name = `job-${randomUUID().slice(0, 8)}`
    // podman writes conmon's pid here as soon as it starts, which is how the placement check
    // finds the sandbox without contending for the container lock
    const stateDir = await mkdtemp(path.join(tmpdir(), "integrator-job-"))
    const conmonPidFile = path.join(stateDir, "conmon.pid")
    const args = ["run", "--rm", "-i", "--name", name, "--conmon-pidfile", conmonPidFile]

    // Fails closed: a job is never launched onto a network whose rules are unverified
    if (spec.network !== false) await this.prepareNetwork()

    if (this.opts.runscPath) {
      args.push("--runtime", this.opts.runscPath, "--runtime-flag=ignore-cgroups")
    }
    // Keeps conmon and the sandbox inside podman's own scope, the one the runner caps. Without
    // it, podman moves conmon to a libpod-conmon-<id>.scope of its own whenever INVOCATION_ID is
    // absent from the environment, and the capped scope then holds nothing but podman itself
    if (this.opts.resourceControl === "systemd-scope") {
      args.push("--cgroups=split")
    }
    args.push(spec.network === false ? "--network=none" : `--network=${this.opts.network}`)
    if (spec.network !== false) {
      for (const server of this.opts.dns) args.push("--dns", server)
    }
    args.push(
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--cpus", String(limits.cpus),
      "-m", `${limits.memoryMb}m`,
      "--pids-limit", String(limits.pidsMax),
      // podman-side hard kill as backstop to our own timer
      "--timeout", String(Math.ceil(limits.timeoutMs / 1000) + 10)
    )

    // /tmp on disk when the caller gives a directory, else a small tmpfs that counts against memory
    if (spec.mounts?.tmpDir) args.push("-v", `${spec.mounts.tmpDir}:/tmp`)
    else args.push("--tmpfs", `/tmp:rw,size=${limits.tmpfsMb}m`)
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
    // Listening from spawn: the steps before the payload is written are async,
    // and a job that exits during them must still be observed
    let exited = false
    const exitCode = new Promise<number | null>(resolve => {
      child.on("close", code => {
        exited = true
        resolve(code)
      })
      child.on("error", () => {
        exited = true
        resolve(null)
      })
    })

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
    let cgroup: string | null = null
    let memoryPeakBytes: number | undefined
    let peakTimer: ReturnType<typeof setInterval> | null = null
    if (this.opts.resourceControl === "systemd-scope" && child.pid !== undefined) {
      try {
        cgroup = await capPodmanScope(child.pid, {
          memoryMb: limits.memoryMb + this.opts.scopeOverheadMb,
          cpus: limits.cpus,
          tasksMax: limits.pidsMax + SCOPE_TASKS_OVERHEAD
        })
        // The cap only counts if the sandbox lives under the capped cgroup
        if (cgroup !== null) await verifyPlacement(conmonPidFile, cgroup, () => exited)
      } catch (err) {
        if (!exited) {
          handle.abort(`resource limits could not be applied: ${(err as Error).message}`)
          await this.removeBeforeStart(name, () => exited)
        }
      }
      if (cgroup !== null) {
        const peakFile = path.join(CGROUP_ROOT, cgroup, "memory.peak")
        const sample = () =>
          readFile(peakFile, "utf8").then(
            text => {
              const bytes = Number(text.trim())
              if (Number.isFinite(bytes)) memoryPeakBytes = Math.max(memoryPeakBytes ?? 0, bytes)
            },
            () => {}
          )
        peakTimer = setInterval(sample, 100)
        void sample()
      }
    }
    // Metered from before the payload is written, so no traffic escapes the count
    let meter: Meter | null = null
    if (abortedReason === null && spec.network !== false && this.opts.egress === "public-only") {
      try {
        meter = await this.attachMeter(name, limits.egressMb, () => exited)
      } catch (err) {
        if (!exited) {
          handle.abort(`network meter could not be attached: ${(err as Error).message}`)
          await this.removeBeforeStart(name, () => exited)
        }
      }
    }
    if (abortedReason === null) child.stdin.write(JSON.stringify(spec.payload ?? null))
    child.stdin.end()

    // Traffic guard: packets past the quota are already dropped; poll the
    // meter so the job fails promptly instead of hanging on stalled transfers
    let egressTimer: ReturnType<typeof setInterval> | null = null
    const quotaMb = limits.egressMb
    if (meter && quotaMb !== undefined) {
      const activeMeter = meter
      let checking = false
      egressTimer = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          const usedMb = Math.round((await this.meterBytes(activeMeter)) / (1024 * 1024))
          if (usedMb > quotaMb) handle.abort(`network traffic reached ${usedMb} MB, over the ${quotaMb} MB quota`)
        } catch {
          // Read again on the next poll; the drop rule still holds
        } finally {
          checking = false
        }
      }, this.opts.diskMonitorMs)
    }

    // Disk guard: /work and a disk-backed /tmp are bind mounts, so no kernel
    // limit applies; poll their usage and kill the job when one crosses its quota
    let diskTimer: ReturnType<typeof setInterval> | null = null
    const guarded: { dir: string; mount: string; quotaMb: number }[] = []
    if (spec.mounts?.workDir && limits.workDiskMb !== undefined) {
      guarded.push({ dir: spec.mounts.workDir, mount: "/work", quotaMb: limits.workDiskMb })
    }
    if (spec.mounts?.tmpDir && limits.tmpDiskMb !== undefined) {
      guarded.push({ dir: spec.mounts.tmpDir, mount: "/tmp", quotaMb: limits.tmpDiskMb })
    }
    if (guarded.length > 0) {
      let checking = false
      diskTimer = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          for (const { dir, mount, quotaMb } of guarded) {
            const usedMb = await dirUsageMb(dir)
            if (usedMb !== null && usedMb > quotaMb) {
              handle.abort(`${mount} reached ${usedMb} MB, over the ${quotaMb} MB quota`)
              return
            }
          }
        } finally {
          checking = false
        }
      }, this.opts.diskMonitorMs)
    }

    const code = await exitCode
    clearTimeout(timer)
    if (diskTimer !== null) clearInterval(diskTimer)
    if (egressTimer !== null) clearInterval(egressTimer)
    if (peakTimer !== null) clearInterval(peakTimer)
    if (lineBuffer && hooks?.onStderrLine) hooks.onStderrLine(lineBuffer)
    await rm(stateDir, { recursive: true, force: true })

    let egressBytes: number | undefined
    if (meter) {
      try {
        egressBytes = await this.detachMeter(meter)
      } catch {
        // Leaves the meter's objects behind; ensureReady in a new netns starts clean
      }
      // A job whose transfers were cut off may still exit 0 with partial data
      if (egressBytes !== undefined && quotaMb !== undefined && egressBytes > quotaMb * 1024 * 1024 && abortedReason === null) {
        abortedReason = `network traffic reached ${Math.round(egressBytes / (1024 * 1024))} MB, over the ${quotaMb} MB quota`
      }
    }

    return {
      status: timedOut ? "timeout" : abortedReason !== null ? "failed" : code === 0 ? "succeeded" : "failed",
      exitCode: code,
      stdout,
      stdoutTruncated,
      stdoutLimitBytes: this.opts.stdoutLimitBytes,
      stderrTail,
      durationMs: Date.now() - started,
      ...(abortedReason !== null ? { abortedReason } : {}),
      ...(egressBytes !== undefined ? { egressBytes } : {}),
      ...(cgroup !== null ? { cgroup } : {}),
      ...(memoryPeakBytes !== undefined ? { memoryPeakBytes } : {})
    }
  }

  /**
   * Kills every job container carrying the label, or the label with the given
   * value. Called at startup to remove containers a previous process left
   * running: a job whose owner is gone has no one to commit its result and
   * would only race the run that replaces it.
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
    await this.nftScript(buildRuleset(this.opts.blockedAddresses))
  }

  /**
   * Removes a job container that must not run, once podman has created it. The job cannot
   * have started: its payload is never written. Killing the podman client instead would
   * leave conmon and the sandbox running with no record of them.
   */
  private async removeBeforeStart(name: string, exited: () => boolean): Promise<void> {
    const deadline = Date.now() + SCOPE_WAIT_MS
    while (!exited() && Date.now() < deadline) {
      if (await this.podmanOk(["rm", "-f", name])) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** Applies an nft script inside the rootless infra netns, atomically. */
  private async nftScript(script: string): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "integrator-nft-"))
    const file = path.join(dir, "rules.nft")
    try {
      await writeFile(file, script)
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
 * The cgroup of podman's own scope (`podman-<pid>.scope`) when podman's current cgroup is that
 * scope or inside it, else null. With --cgroups=split podman moves itself into the scope and,
 * tens of milliseconds later, into a `runtime` child of it, so a poll can see either. Exported
 * for tests.
 */
export function podmanScopeCgroup(cgroup: string, pid: number): string | null {
  const unit = `podman-${pid}.scope`
  if (cgroup.endsWith(`/${unit}`)) return cgroup
  const at = cgroup.indexOf(`/${unit}/`)
  return at >= 0 ? cgroup.slice(0, at + unit.length + 1) : null
}

/**
 * Caps the transient scope rootless podman moves itself into
 * (`podman-<pid>.scope`), which also holds conmon and the gVisor sandbox.
 * Waits for podman to make the move; refuses any other cgroup, since capping
 * the caller's own unit would limit the caller instead of the job.
 */
async function capPodmanScope(pid: number, limits: ScopeLimits): Promise<string | null> {
  const unit = `podman-${pid}.scope`
  const deadline = Date.now() + SCOPE_WAIT_MS
  let cgroup = ""
  for (;;) {
    let current: string
    try {
      // The cgroup v2 line is "0::<path>"; v1 controller lines may precede it
      const lines = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim().split("\n")
      current = lines.find(line => line.startsWith("0::"))?.slice(3) ?? ""
    } catch {
      // podman already exited: nothing left to cap
      return null
    }
    const scope = podmanScopeCgroup(current, pid)
    if (scope !== null) {
      cgroup = scope
      break
    }
    if (Date.now() > deadline) throw new Error(`podman did not move into ${unit} (cgroup ${current})`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await execFileP("systemctl", [
    "--user", "set-property", "--runtime", unit,
    `MemoryMax=${Math.round(limits.memoryMb)}M`,
    "MemorySwapMax=0",
    `CPUQuota=${Math.round(limits.cpus * 100)}%`,
    `TasksMax=${limits.tasksMax}`
  ])
  // systemd reports success even when a controller is unavailable in this cgroup tree, so
  // the kernel's own files are the only proof the limits hold; the job never starts without it
  const verifyDeadline = Date.now() + SCOPE_VERIFY_MS
  for (;;) {
    const problem = await scopeLimitsProblem(path.join(CGROUP_ROOT, cgroup), limits)
    if (problem === null) return cgroup
    if (Date.now() > verifyDeadline) throw new Error(`limits are not in effect on ${unit}: ${problem}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Requires the job's container monitor (conmon, whose children are the gVisor sandbox) to be
 * inside the capped cgroup. Waits for podman to write conmon's pid; the harness is still
 * blocked on stdin, so nothing runs meanwhile.
 */
async function verifyPlacement(conmonPidFile: string, cgroup: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + SCOPE_WAIT_MS
  for (;;) {
    const conmonPid = Number((await readFile(conmonPidFile, "utf8").catch(() => "")).trim())
    if (conmonPid > 0) {
      const lines = (await readFile(`/proc/${conmonPid}/cgroup`, "utf8")).trim().split("\n")
      const actual = lines.find(line => line.startsWith("0::"))?.slice(3) ?? ""
      if (actual === cgroup || actual.startsWith(cgroup + "/")) return
      throw new Error(`the sandbox runs in ${actual}, outside the capped ${cgroup}`)
    }
    if (exited()) return
    if (Date.now() > deadline) throw new Error(`container did not start within ${SCOPE_WAIT_MS / 1000} s`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * Compares a scope's cgroup v2 limit files with the limits requested; returns what differs,
 * or null when every limit is in effect. Exported for tests.
 */
export async function scopeLimitsProblem(cgroupDir: string, limits: ScopeLimits): Promise<string | null> {
  const expected: Record<string, string> = {
    "memory.max": String(Math.round(limits.memoryMb) * 1024 * 1024),
    "memory.swap.max": "0",
    "pids.max": String(limits.tasksMax),
    "cpu.max": `${Math.round(limits.cpus * 100) * 1000} 100000`
  }
  const problems: string[] = []
  for (const [file, want] of Object.entries(expected)) {
    let got: string
    try {
      got = (await readFile(path.join(cgroupDir, file), "utf8")).trim()
    } catch (err) {
      problems.push(`${file} unreadable (${(err as NodeJS.ErrnoException).code ?? err})`)
      continue
    }
    if (got !== want) problems.push(`${file} is "${got}", expected "${want}"`)
  }
  return problems.length > 0 ? problems.join("; ") : null
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

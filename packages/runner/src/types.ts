/** Resource limits applied to a single job container. */
export interface JobLimits {
  /** CPU cores available to the job */
  cpus?: number
  /** Memory ceiling in MB */
  memoryMb?: number
  /** Wall-clock timeout in ms before the job is killed */
  timeoutMs?: number
  /** Maximum number of processes/threads */
  pidsMax?: number
  /** Size of the writable /tmp tmpfs in MB (rootfs is read-only), when mounts.tmpDir is absent */
  tmpfsMb?: number
  /** Ceiling on /work usage in MB; the job is aborted when a poll finds it exceeded */
  workDiskMb?: number
  /** Ceiling on /tmp usage in MB when mounts.tmpDir is given; the job is aborted when a poll finds it exceeded */
  tmpDiskMb?: number
  /**
   * Ceiling on network traffic in MB, both directions combined. Packets past it
   * are dropped, and the job is aborted when a poll finds it exceeded. Only
   * under the "public-only" egress policy.
   */
  egressMb?: number
}

/** Host directories bind-mounted into the job container. */
export interface JobMounts {
  /** Resolved inputs, mounted read-only at /in */
  inDir?: string
  /** Persistent workspace (cache semantics), mounted at /work */
  workDir?: string
  /** Artifact output, mounted at /out */
  outDir?: string
  /**
   * Per-job temporary space on disk, mounted at /tmp in place of the tmpfs, so
   * large intermediates neither count against memory nor persist in /work. The
   * caller creates it empty and removes it after the job.
   */
  tmpDir?: string
  /** Additional host paths mounted read-only, e.g. a shared raster store */
  readOnly?: ReadOnlyMount[]
}

/** A host directory the job may read but not write. */
export interface ReadOnlyMount {
  /** Absolute host path */
  hostPath: string
  /** Absolute path inside the container */
  containerPath: string
}

/** Everything needed to execute one job. */
export interface JobSpec {
  /** Container image to run */
  image: string
  /** JSON payload written to the job's stdin */
  payload: unknown
  /** Host directories mounted into the container */
  mounts?: JobMounts
  /** Resource limits; runner defaults apply when absent */
  limits?: JobLimits
  /** Override the image entrypoint (tests, snippet mode) */
  command?: string[]
  /** Non-secret environment. Secrets travel in the payload, never in env. */
  env?: Record<string, string>
  /** false = --network=none */
  network?: boolean
  /** Container labels, e.g. the owning run id, so orphans can be found and killed */
  labels?: Record<string, string>
}

/** Terminal state of a job. */
export type JobStatus = "succeeded" | "failed" | "timeout"

/** Outcome of a completed job. */
export interface JobResult {
  /** How the job ended */
  status: JobStatus
  /** Container exit code; null if the process could not be observed */
  exitCode: number | null
  /** Raw stdout (capped). The harness contract puts the result JSON here. */
  stdout: string
  /** True when stdout exceeded the cap and was cut off */
  stdoutTruncated: boolean
  /** The cap stdout was captured under */
  stdoutLimitBytes: number
  /** Trailing stderr output, capped; first place to look on failure */
  stderrTail: string
  /** Wall-clock duration of the run in ms */
  durationMs: number
  /** Reason the job was aborted through its handle, when it was */
  abortedReason?: string
  /** Network bytes in and out of the job, measured under the "public-only" egress policy */
  egressBytes?: number
  /** cgroup the job's limits were applied to, under "systemd-scope" resource control */
  cgroup?: string
  /** Peak memory of that cgroup during the job in bytes, sampled once a second */
  memoryPeakBytes?: number
}

/** Configuration of a Runner instance. */
export interface RunnerOptions {
  /** Path to runsc. null runs without gVisor (dev only). */
  runscPath?: string | null
  /** Path to the podman binary */
  podmanPath?: string
  /** Dedicated bridge network for jobs; required for egress filtering. */
  network?: string
  /** "public-only" (default) blocks private/link-local egress; "open" skips rules. */
  egress?: "public-only" | "open"
  /**
   * Additional destinations blocked under "public-only": IPv4/IPv6 addresses
   * or CIDRs. The default set covers private ranges only, so a deployment
   * lists its own hosts' public addresses here.
   */
  blockedAddresses?: string[]
  /** How often the /work disk guard polls, in ms (default 30 s) */
  diskMonitorMs?: number
  /**
   * DNS servers passed to job containers. Defaults to public resolvers: host
   * resolv.conf is unreliable under the rootless netns (systemd-resolved stub
   * is unreachable there, leaving aardvark-dns with no upstream).
   */
  dns?: string[]
  /** Cap on captured stdout bytes */
  stdoutLimitBytes?: number
  /** Cap on retained stderr bytes */
  stderrLimitBytes?: number
  /**
   * How CPU, memory and process limits are enforced. Under gVisor the
   * container cgroup is ignored (`--runtime-flag=ignore-cgroups`, required
   * rootless), so podman's own limit flags have no effect.
   * - "systemd-scope" (default with gVisor): caps the transient systemd user
   *   scope podman runs the job in, before the payload is written, so job code
   *   never runs uncapped. Needs a systemd user manager (linger, XDG_RUNTIME_DIR).
   *   The job fails if the cap cannot be applied.
   * - "podman": podman's flags only; enforced without gVisor (dev).
   */
  resourceControl?: "systemd-scope" | "podman"
  /**
   * Memory allowed in the job's scope beyond JobLimits.memoryMb, in MB, for
   * the podman client, conmon, the gVisor sentry and gofer (default 256)
   */
  scopeOverheadMb?: number
}

/** Live handle to an executing job. */
export interface JobHandle {
  /** Kills the container now; the result reports "failed" with this reason */
  abort: (reason: string) => void
}

/** Callbacks invoked during a run. */
export interface RunHooks {
  /** Called for each complete line of stderr as it streams */
  onStderrLine?: (line: string) => void
  /** Called once the container has been spawned, with its abort handle */
  onStart?: (handle: JobHandle) => void
}

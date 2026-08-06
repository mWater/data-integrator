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
  /** Size of the writable /tmp tmpfs in MB (rootfs is read-only) */
  tmpfsMb?: number
}

/** Host directories bind-mounted into the job container. */
export interface JobMounts {
  /** Resolved inputs, mounted read-only at /in */
  inDir?: string
  /** Persistent workspace (cache semantics), mounted at /work */
  workDir?: string
  /** Artifact output, mounted at /out */
  outDir?: string
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
  /** Trailing stderr output, capped; first place to look on failure */
  stderrTail: string
  /** Wall-clock duration of the run in ms */
  durationMs: number
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
  /** Cap on captured stdout bytes */
  stdoutLimitBytes?: number
  /** Cap on retained stderr bytes */
  stderrLimitBytes?: number
}

/** Callbacks invoked during a run. */
export interface RunHooks {
  /** Called for each complete line of stderr as it streams */
  onStderrLine?: (line: string) => void
}

export interface JobLimits {
  cpus?: number
  memoryMb?: number
  timeoutMs?: number
  pidsMax?: number
  /** Size of the writable /tmp tmpfs (rootfs is read-only) */
  tmpfsMb?: number
}

export interface JobMounts {
  /** Resolved inputs, mounted read-only at /in */
  inDir?: string
  /** Persistent workspace (cache semantics), mounted at /work */
  workDir?: string
  /** Artifact output, mounted at /out */
  outDir?: string
}

export interface JobSpec {
  image: string
  /** JSON payload written to the job's stdin */
  payload: unknown
  mounts?: JobMounts
  limits?: JobLimits
  /** Override the image entrypoint (tests, snippet mode) */
  command?: string[]
  /** Non-secret environment. Secrets travel in the payload, never in env. */
  env?: Record<string, string>
  /** false = --network=none */
  network?: boolean
}

export type JobStatus = "succeeded" | "failed" | "timeout"

export interface JobResult {
  status: JobStatus
  exitCode: number | null
  /** Raw stdout (capped). The harness contract puts the result JSON here. */
  stdout: string
  stdoutTruncated: boolean
  stderrTail: string
  durationMs: number
}

export interface RunnerOptions {
  /** Path to runsc. null runs without gVisor (dev only). */
  runscPath?: string | null
  podmanPath?: string
  /** Dedicated bridge network for jobs; required for egress filtering. */
  network?: string
  /** "public-only" (default) blocks private/link-local egress; "open" skips rules. */
  egress?: "public-only" | "open"
  stdoutLimitBytes?: number
  stderrLimitBytes?: number
}

export interface RunHooks {
  onStderrLine?: (line: string) => void
}

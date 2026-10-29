/**
 * Central environment configuration. The environment variables the server
 * reads are resolved and validated here, once, at startup, except the AI
 * provider variables, which only seed the stored AI settings (aiSettings.ts);
 * the rest of the code takes typed AppConfig pieces. loadConfig throws a single error listing
 * every problem, so a misconfigured deployment fails fast and completely.
 * The variables are documented in .env.example at the repository root.
 */

import { loadSecretKey } from "./secrets.js"
import { availableParallelism, totalmem } from "node:os"
import { isIP } from "node:net"
import { DEFAULT_RENDER_CONCURRENCY } from "./tiles.js"

/** Reasoning efforts OpenRouter accepts for AGENT_EFFORT. */
export const AGENT_EFFORTS = ["xhigh", "high", "medium", "low", "minimal", "none"] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

/** Validated server configuration; see .env.example for the variable docs. */
export interface AppConfig {
  /** DATABASE_URL (required) */
  databaseUrl: string
  /** PORT for `serve` */
  port: number
  /** RASTER_STORE_PATH: raster snapshot files */
  rasterStorePath: string
  /** WORK_ROOT: per-integration persistent /work directories */
  workRoot: string
  /** FILE_STORE_PATH: uploaded integration file versions */
  fileStorePath: string
  /** FILE_UPLOAD_MAX_MB: largest accepted file upload */
  fileUploadMaxMb: number
  /** TILE_CACHE_PATH: rendered tile + basemap cache */
  tileCachePath: string
  /** LIBRARY_PATH: integration library root (integrations/, skills/) */
  libraryPath: string
  /** UI_DIST_PATH: built SPA directory; null uses the in-repo default */
  uiDistPath: string | null
  /** VITE_DEV_URL: live Vite origin for `pnpm dev`; null serves the built SPA */
  viteDevUrl: string | null
  /** INTEGRATOR_SECRET_KEY parsed to 32 bytes; null when unset */
  secretKey: Buffer | null
  /** RUNTIME_IMAGE_PYTHON / RUNTIME_IMAGE_NODE job images */
  runtimeImages: { python: string; node: string }
  /** WORK_QUOTA_MB: /work ceiling and default per integration; 0 disables */
  workQuotaMb: number
  /** TMP_QUOTA_MB: per-run /tmp ceiling and default (temporary disk under the work root); 0 leaves it uncapped */
  tmpQuotaMb: number
  /** MIN_FREE_DISK_MB: free-space floor on work root and raster store; 0 disables */
  minFreeDiskMb: number
  /** TILE_CACHE_MB: tile + basemap cache budget, evicted oldest-first; 0 disables */
  tileCacheMb: number
  /** TILE_RENDER_CONCURRENCY: map tile renders (GDAL subprocess pipelines) allowed at once */
  tileRenderConcurrency: number
  /** SANDBOX_MEMORY_MB: total job sandbox memory admitted at once; 0 disables the budget */
  sandboxMemoryMb: number
  /** Ceilings on what a definition's limits may request; 0 disables each */
  jobMax: {
    /** JOB_MAX_CPUS: CPU cores */
    cpus: number
    /** JOB_MAX_MEMORY_MB: memory in MB */
    memoryMb: number
    /** JOB_MAX_TIMEOUT_MIN: wall-clock timeout in minutes */
    timeoutMin: number
  }
  /** JOB_BLOCKED_ADDRESSES: addresses or CIDRs jobs may not reach, beyond the private ranges always blocked */
  jobBlockedAddresses: string[]
  /** Agent tuning; the provider, key and model are set in Settings (aiSettings.ts) */
  agent: {
    /** AGENT_EFFORT; null uses the model default */
    effort: AgentEffort | null
  }
  /** Basemap proxy upstream; upstream null disables the proxy */
  basemap: { upstream: string | null; styleLight: string; styleDark: string }
}

/** Host RAM the operating system, database, server, and tile renders keep for themselves. */
const HOST_RESERVE_MB = 2048

/**
 * Default sandbox budget: physical memory less the host reserve, never
 * below one runner-default job (2048 MB) so a small box still runs jobs,
 * one at a time.
 */
export function defaultSandboxMemoryMb(totalMb = Math.floor(totalmem() / (1024 * 1024))): number {
  return Math.max(2048, totalMb - HOST_RESERVE_MB)
}

/**
 * Resolves and validates configuration from the environment. Throws one
 * error naming every missing or malformed variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = []

  const databaseUrl = env.DATABASE_URL ?? ""
  if (!databaseUrl) {
    problems.push("DATABASE_URL is required (postgres://user:pass@host:port/db)")
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgres:// or postgresql:// URL")
  }

  const portRaw = env.PORT ?? "8080"
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535, got "${portRaw}"`)
  }

  let secretKey: Buffer | null = null
  if (env.INTEGRATOR_SECRET_KEY) {
    try {
      secretKey = loadSecretKey(env)
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }

  const quota = (name: string, fallback: number, unit = "megabytes"): number => {
    const raw = env[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${name} must be a non-negative integer of ${unit}, got "${raw}"`)
      return fallback
    }
    return value
  }
  const workQuotaMb = quota("WORK_QUOTA_MB", 20480)
  const tmpQuotaMb = quota("TMP_QUOTA_MB", 20480)
  const minFreeDiskMb = quota("MIN_FREE_DISK_MB", 2048)
  const tileCacheMb = quota("TILE_CACHE_MB", 1024)
  const sandboxMemoryMb = quota("SANDBOX_MEMORY_MB", defaultSandboxMemoryMb())
  const jobMax = {
    cpus: quota("JOB_MAX_CPUS", availableParallelism(), "cores"),
    memoryMb: quota("JOB_MAX_MEMORY_MB", sandboxMemoryMb),
    timeoutMin: quota("JOB_MAX_TIMEOUT_MIN", 360, "minutes")
  }

  const jobBlockedAddresses = (env.JOB_BLOCKED_ADDRESSES ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
  for (const entry of jobBlockedAddresses) {
    const [address, prefix, extra] = entry.split("/")
    const family = isIP(address)
    const maxPrefix = family === 6 ? 128 : 32
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix)
    if (family === 0 || !prefixOk || extra !== undefined) {
      problems.push(`JOB_BLOCKED_ADDRESSES: "${entry}" is not an IPv4/IPv6 address or CIDR`)
    }
  }
  const uploadRaw = env.FILE_UPLOAD_MAX_MB ?? "100"
  const fileUploadMaxMb = Number(uploadRaw)
  if (!Number.isInteger(fileUploadMaxMb) || fileUploadMaxMb < 1) {
    problems.push(`FILE_UPLOAD_MAX_MB must be a positive integer of megabytes, got "${uploadRaw}"`)
  }

  const concurrencyRaw = env.TILE_RENDER_CONCURRENCY ?? String(DEFAULT_RENDER_CONCURRENCY)
  const tileRenderConcurrency = Number(concurrencyRaw)
  if (!Number.isInteger(tileRenderConcurrency) || tileRenderConcurrency < 1) {
    problems.push(`TILE_RENDER_CONCURRENCY must be a positive integer, got "${concurrencyRaw}"`)
  }

  const effortRaw = env.AGENT_EFFORT
  if (effortRaw && !AGENT_EFFORTS.includes(effortRaw as AgentEffort)) {
    problems.push(`AGENT_EFFORT must be one of ${AGENT_EFFORTS.join(", ")}, got "${effortRaw}"`)
  }

  const viteDevUrl = env.VITE_DEV_URL?.trim().replace(/\/+$/, "") || null
  if (viteDevUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(viteDevUrl)) {
    problems.push(`VITE_DEV_URL must be a local http(s) origin, got "${viteDevUrl}"`)
  }

  if (problems.length > 0) {
    throw new Error(`Configuration errors:\n  - ${problems.join("\n  - ")}`)
  }

  const basemapRaw = (env.BASEMAP_UPSTREAM ?? "https://tiles.openfreemap.org").trim()
  const basemapDisabled = basemapRaw === "off" || basemapRaw === "none" || basemapRaw === ""

  return {
    databaseUrl,
    port,
    rasterStorePath: env.RASTER_STORE_PATH ?? "./raster-store",
    workRoot: env.WORK_ROOT ?? "./work",
    fileStorePath: env.FILE_STORE_PATH ?? "./file-store",
    fileUploadMaxMb,
    tileCachePath: env.TILE_CACHE_PATH ?? "./tile-cache",
    libraryPath: env.LIBRARY_PATH ?? "./library",
    uiDistPath: env.UI_DIST_PATH ?? null,
    viteDevUrl,
    secretKey,
    workQuotaMb,
    tmpQuotaMb,
    minFreeDiskMb,
    tileCacheMb,
    tileRenderConcurrency,
    sandboxMemoryMb,
    jobMax,
    jobBlockedAddresses,
    runtimeImages: {
      python: env.RUNTIME_IMAGE_PYTHON ?? "localhost/integrator-runtime-python:dev",
      node: env.RUNTIME_IMAGE_NODE ?? "localhost/integrator-runtime-node:dev"
    },
    agent: {
      effort: (effortRaw as AgentEffort | undefined) ?? null
    },
    basemap: {
      upstream: basemapDisabled ? null : basemapRaw.replace(/\/+$/, ""),
      styleLight: env.BASEMAP_STYLE_LIGHT ?? "styles/positron",
      styleDark: env.BASEMAP_STYLE_DARK ?? "styles/dark"
    }
  }
}

/**
 * Which kind of model endpoint the agents talk to. "custom" means the admin
 * points at their own infrastructure, so the external-provider
 * acknowledgement does not apply.
 */
export type AiProvider = "openrouter" | "anthropic" | "custom"

/**
 * One-line effective-config summary for the startup log: every path and
 * switch, no secret values.
 */
export function describeConfig(config: AppConfig): string {
  return [
    `port=${config.port}`,
    `rasterStore=${config.rasterStorePath}`,
    `workRoot=${config.workRoot}`,
    `fileStore=${config.fileStorePath}`,
    `tileCache=${config.tileCachePath}`,
    `secrets=${config.secretKey ? "on" : "off"}`,
    `basemap=${config.basemap.upstream ?? "off"}`,
    `ui=${config.viteDevUrl ? `vite:${config.viteDevUrl}` : "dist"}`
  ].join(" ")
}

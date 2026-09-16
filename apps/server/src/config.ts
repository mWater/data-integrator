/**
 * Central environment configuration. Every environment variable the server
 * reads is resolved and validated here, once, at startup; the rest of the
 * code takes typed AppConfig pieces. loadConfig throws a single error listing
 * every problem, so a misconfigured deployment fails fast and completely.
 * The variables are documented in .env.example at the repository root.
 */

import { loadSecretKey } from "./secrets.js"
import { totalmem } from "node:os"
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
  /** TILE_CACHE_PATH: rendered tile + basemap cache */
  tileCachePath: string
  /** LIBRARY_PATH: integration library root (integrations/, skills/) */
  libraryPath: string
  /** UI_DIST_PATH: built SPA directory; null uses the in-repo default */
  uiDistPath: string | null
  /** VITE_DEV_URL: live Vite origin for `pnpm dev`; null serves the built SPA */
  viteDevUrl: string | null
  /** PATHFINDER_SECRET_KEY parsed to 32 bytes; null when unset */
  secretKey: Buffer | null
  /** RUNTIME_IMAGE_PYTHON / RUNTIME_IMAGE_NODE job images */
  runtimeImages: { python: string; node: string }
  /** WORK_QUOTA_MB: /work ceiling and default per integration; 0 disables */
  workQuotaMb: number
  /** MIN_FREE_DISK_MB: free-space floor on work root and raster store; 0 disables */
  minFreeDiskMb: number
  /** TILE_CACHE_MB: tile + basemap cache budget, evicted oldest-first; 0 disables */
  tileCacheMb: number
  /** TILE_RENDER_CONCURRENCY: map tile renders (GDAL subprocess pipelines) allowed at once */
  tileRenderConcurrency: number
  /** SANDBOX_MEMORY_MB: total job sandbox memory admitted at once; 0 disables the budget */
  sandboxMemoryMb: number
  /** Agent model wiring; no key and no base URL means no model (core runs AI-free) */
  agent: {
    /** LLM_BASE_URL: any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM…); wins over the hosted keys */
    baseUrl: string | null
    /** LLM_API_KEY for the LLM_BASE_URL endpoint; null when the endpoint needs none */
    baseUrlKey: string | null
    openrouterKey: string | null
    anthropicKey: string | null
    /** AGENT_MODEL; null uses the provider default (required with LLM_BASE_URL) */
    model: string | null
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
  if (env.PATHFINDER_SECRET_KEY ?? env.INTEGRATOR_SECRET_KEY) {
    try {
      secretKey = loadSecretKey(env)
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }

  const quota = (name: string, fallback: number): number => {
    const raw = env[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${name} must be a non-negative integer of megabytes, got "${raw}"`)
      return fallback
    }
    return value
  }
  const workQuotaMb = quota("WORK_QUOTA_MB", 20480)
  const minFreeDiskMb = quota("MIN_FREE_DISK_MB", 2048)
  const tileCacheMb = quota("TILE_CACHE_MB", 1024)
  const sandboxMemoryMb = quota("SANDBOX_MEMORY_MB", defaultSandboxMemoryMb())

  const concurrencyRaw = env.TILE_RENDER_CONCURRENCY ?? String(DEFAULT_RENDER_CONCURRENCY)
  const tileRenderConcurrency = Number(concurrencyRaw)
  if (!Number.isInteger(tileRenderConcurrency) || tileRenderConcurrency < 1) {
    problems.push(`TILE_RENDER_CONCURRENCY must be a positive integer, got "${concurrencyRaw}"`)
  }

  const effortRaw = env.AGENT_EFFORT
  if (effortRaw && !AGENT_EFFORTS.includes(effortRaw as AgentEffort)) {
    problems.push(`AGENT_EFFORT must be one of ${AGENT_EFFORTS.join(", ")}, got "${effortRaw}"`)
  }

  const llmBaseUrl = env.LLM_BASE_URL?.trim().replace(/\/+$/, "") || null
  if (llmBaseUrl && !/^https?:\/\//.test(llmBaseUrl)) {
    problems.push(`LLM_BASE_URL must be an http(s) URL, got "${llmBaseUrl}"`)
  }

  const viteDevUrl = env.VITE_DEV_URL?.trim().replace(/\/+$/, "") || null
  if (viteDevUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(viteDevUrl)) {
    problems.push(`VITE_DEV_URL must be a local http(s) origin, got "${viteDevUrl}"`)
  }
  if (llmBaseUrl && !env.AGENT_MODEL) {
    problems.push("AGENT_MODEL is required when LLM_BASE_URL is set (the endpoint's model name)")
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
    tileCachePath: env.TILE_CACHE_PATH ?? "./tile-cache",
    libraryPath: env.LIBRARY_PATH ?? "./library",
    uiDistPath: env.UI_DIST_PATH ?? null,
    viteDevUrl,
    secretKey,
    workQuotaMb,
    minFreeDiskMb,
    tileCacheMb,
    tileRenderConcurrency,
    sandboxMemoryMb,
    runtimeImages: {
      python: env.RUNTIME_IMAGE_PYTHON ?? "localhost/pathfinder-runtime-python:dev",
      node: env.RUNTIME_IMAGE_NODE ?? "localhost/pathfinder-runtime-node:dev"
    },
    agent: {
      baseUrl: llmBaseUrl,
      baseUrlKey: env.LLM_API_KEY ?? null,
      openrouterKey: env.OPENROUTER_API_KEY ?? null,
      anthropicKey: env.ANTHROPIC_API_KEY ?? null,
      model: env.AGENT_MODEL ?? null,
      effort: (effortRaw as AgentEffort | undefined) ?? null
    },
    basemap: {
      upstream: basemapDisabled ? null : basemapRaw.replace(/\/+$/, ""),
      styleLight: env.BASEMAP_STYLE_LIGHT ?? "styles/positron",
      styleDark: env.BASEMAP_STYLE_DARK ?? "styles/dark"
    }
  }
}

/** Which kind of model endpoint the agents talk to. */
export type AiProvider = "openrouter" | "anthropic" | "custom"

/**
 * The configured model provider, mirroring buildModel's precedence: a custom
 * OpenAI-compatible endpoint wins, then OpenRouter, then Anthropic. "custom"
 * means the admin points at their own infrastructure, so the external-provider
 * acknowledgement does not apply.
 */
export function aiProvider(config: AppConfig): AiProvider | null {
  if (config.agent.baseUrl) return "custom"
  if (config.agent.openrouterKey) return "openrouter"
  if (config.agent.anthropicKey) return "anthropic"
  return null
}

/**
 * One-line effective-config summary for the startup log: every path and
 * switch, no secret values.
 */
export function describeConfig(config: AppConfig): string {
  const model = config.agent.baseUrl
    ? `${config.agent.baseUrl}:${config.agent.model}`
    : config.agent.openrouterKey
      ? `openrouter:${config.agent.model ?? "(default)"}`
      : config.agent.anthropicKey
        ? `anthropic:${config.agent.model ?? "(default)"}`
        : "none"
  return [
    `port=${config.port}`,
    `rasterStore=${config.rasterStorePath}`,
    `workRoot=${config.workRoot}`,
    `tileCache=${config.tileCachePath}`,
    `secrets=${config.secretKey ? "on" : "off"}`,
    `model=${model}`,
    `basemap=${config.basemap.upstream ?? "off"}`,
    `ui=${config.viteDevUrl ? `vite:${config.viteDevUrl}` : "dist"}`
  ].join(" ")
}

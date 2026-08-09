/**
 * Central environment configuration. Every environment variable the server
 * reads is resolved and validated here, once, at startup; the rest of the
 * code takes typed AppConfig pieces. loadConfig throws a single error listing
 * every problem, so a misconfigured deployment fails fast and completely.
 * The variables are documented in .env.example at the repository root.
 */

import { loadSecretKey } from "./secrets.js"

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
  /** INTEGRATOR_SECRET_KEY parsed to 32 bytes; null when unset */
  secretKey: Buffer | null
  /** RUNTIME_IMAGE_PYTHON / RUNTIME_IMAGE_NODE job images */
  runtimeImages: { python: string; node: string }
  /** Agent model wiring; both keys null means no model (core runs AI-free) */
  agent: {
    openrouterKey: string | null
    anthropicKey: string | null
    /** AGENT_MODEL; null uses the provider default */
    model: string | null
    /** AGENT_EFFORT; null uses the model default */
    effort: AgentEffort | null
  }
  /** Basemap proxy upstream; upstream null disables the proxy */
  basemap: { upstream: string | null; styleLight: string; styleDark: string }
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

  const effortRaw = env.AGENT_EFFORT
  if (effortRaw && !AGENT_EFFORTS.includes(effortRaw as AgentEffort)) {
    problems.push(`AGENT_EFFORT must be one of ${AGENT_EFFORTS.join(", ")}, got "${effortRaw}"`)
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
    secretKey,
    runtimeImages: {
      python: env.RUNTIME_IMAGE_PYTHON ?? "localhost/integrator-runtime-python:dev",
      node: env.RUNTIME_IMAGE_NODE ?? "localhost/integrator-runtime-node:dev"
    },
    agent: {
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

/**
 * One-line effective-config summary for the startup log: every path and
 * switch, no secret values.
 */
export function describeConfig(config: AppConfig): string {
  const model = config.agent.openrouterKey
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
    `basemap=${config.basemap.upstream ?? "off"}`
  ].join(" ")
}

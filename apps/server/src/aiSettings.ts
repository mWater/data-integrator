/**
 * The deployment's AI model provider, set by admins in Settings and stored in
 * app.settings with the API key encrypted under INTEGRATOR_SECRET_KEY. The
 * running server holds one AiRuntime whose model is a stable handle the
 * agents keep; saving new settings swaps what the handle calls, so a change
 * applies without a restart.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, LanguageModel } from "ai"
import pg from "pg"
import { AgentEffort, AiProvider } from "./config.js"
import { decryptSecret, encryptSecret } from "./secrets.js"
import { getSetting, setSetting } from "./settings.js"

/** Settings key holding the stored AI configuration. */
export const AI_KEY = "ai"

/** Default model per hosted provider; see Quickstart "Choosing a model". */
export const DEFAULT_MODELS = { openrouter: "openai/gpt-6.1-sol", anthropic: "claude-opus-5-5" } as const

/** Longest model id or base URL accepted. */
const MAX_FIELD = 500

/** A provider configuration with its key in the clear. */
export interface AiConfig {
  /** Which kind of endpoint the agents talk to */
  provider: AiProvider
  /** Model id; null uses the provider default (required for custom) */
  model: string | null
  /** OpenAI-compatible endpoint for custom; null otherwise */
  baseUrl: string | null
  /** API key; null only for a custom endpoint that needs none */
  apiKey: string | null
}

/** The stored form: the key is base64 AES-GCM ciphertext. */
interface StoredAiConfig {
  /** Provider kind */
  provider: AiProvider
  /** Model id or null */
  model: string | null
  /** Custom endpoint or null */
  baseUrl: string | null
  /** Encrypted API key, base64; null when none */
  apiKey: string | null
}

/** What admins see of the stored configuration: never the key itself. */
export interface AiSettingsView {
  /** Provider kind; null when AI is off */
  provider: AiProvider | null
  /** Model id as saved; null uses the default */
  model: string | null
  /** Custom endpoint; null otherwise */
  baseUrl: string | null
  /** True when an API key is saved */
  keySaved: boolean
  /** False when INTEGRATOR_SECRET_KEY is unset, so no key can be stored */
  canStoreKeys: boolean
  /** Default model per hosted provider */
  defaults: typeof DEFAULT_MODELS
}

/** Builds the language model for a configuration. */
export function buildModel(config: AiConfig, effort: AgentEffort | null): LanguageModel {
  if (config.provider === "custom") {
    // Self-hosted or third-party endpoint (vLLM, Ollama, LiteLLM…). No
    // effort/caching knobs: those vary by server.
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: config.baseUrl!,
      ...(config.apiKey ? { apiKey: config.apiKey } : {})
    })
    return provider(config.model!)
  }
  if (config.provider === "openrouter") {
    const modelId = config.model ?? DEFAULT_MODELS.openrouter
    // The default model runs at medium effort unless AGENT_EFFORT says otherwise
    const resolvedEffort = effort ?? (modelId === DEFAULT_MODELS.openrouter ? "medium" : undefined)
    // Anthropic only caches prompts on an explicit directive (OpenAI and Gemini
    // cache automatically); 1h TTL because sandbox jobs and user think-time
    // routinely outlast the 5m default
    const settings = {
      ...(modelId.startsWith("anthropic/")
        ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
        : {}),
      ...(resolvedEffort ? { reasoning: { effort: resolvedEffort } } : {})
    }
    return createOpenRouter({ apiKey: config.apiKey! })(modelId, settings)
  }
  return createAnthropic({ apiKey: config.apiKey! })(config.model ?? DEFAULT_MODELS.anthropic)
}

/** Effective model id for display: the saved one or the provider default. */
export function effectiveModelId(config: AiConfig): string {
  return config.model ?? (config.provider === "custom" ? "" : DEFAULT_MODELS[config.provider])
}

/**
 * Validates an admin's save request. A blank key keeps the saved one only
 * when the provider and endpoint are unchanged, so a stored key is never
 * sent to an endpoint other than the one it was entered for.
 */
export function parseAiConfig(body: unknown, current: AiConfig | null): AiConfig {
  if (typeof body !== "object" || body === null) throw new Error("Expected a JSON object")
  const b = body as Record<string, unknown>
  const provider = b.provider
  if (provider !== "openrouter" && provider !== "anthropic" && provider !== "custom") {
    throw new Error("provider must be openrouter, anthropic, or custom")
  }
  const text = (name: string): string | null => {
    const value = b[name]
    if (value == null) return null
    if (typeof value !== "string") throw new Error(`${name} must be a string`)
    const trimmed = value.trim()
    if (trimmed.length > MAX_FIELD) throw new Error(`${name} is too long`)
    return trimmed || null
  }
  const model = text("model")
  let baseUrl: string | null = null
  if (provider === "custom") {
    baseUrl = text("baseUrl")?.replace(/\/+$/, "") ?? null
    if (!baseUrl) throw new Error("A custom endpoint needs its base URL")
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error("The base URL is not a valid URL")
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("The base URL must use http or https")
    if (parsed.username || parsed.password) throw new Error("Put the API key in the key field, not in the URL")
    if (!model) throw new Error("A custom endpoint needs the model name it serves")
  }
  let apiKey = text("apiKey")
  if (!apiKey && current && current.provider === provider && current.baseUrl === baseUrl) apiKey = current.apiKey
  if (!apiKey && provider !== "custom") throw new Error("Enter the provider's API key")
  return { provider, model, baseUrl, apiKey }
}

/**
 * Sends one tiny request so a wrong key, model or endpoint is reported at save
 * time rather than in the first user's session.
 */
export async function testModel(model: LanguageModel): Promise<void> {
  await generateText({
    model,
    prompt: "Reply with the word OK.",
    maxOutputTokens: 64,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(30_000)
  })
}

/** Reads and decrypts the stored configuration; null when AI is off. */
export async function loadAiConfig(pool: pg.Pool, secretKey: Buffer | null): Promise<AiConfig | null> {
  const stored = await getSetting<StoredAiConfig>(pool, AI_KEY)
  if (!stored) return null
  let apiKey: string | null = null
  if (stored.apiKey) {
    if (!secretKey) throw new Error("An AI provider key is saved but INTEGRATOR_SECRET_KEY is not set")
    apiKey = decryptSecret(secretKey, Buffer.from(stored.apiKey, "base64"))
  }
  return { provider: stored.provider, model: stored.model, baseUrl: stored.baseUrl, apiKey }
}

/** Encrypts and stores a configuration; null turns AI off. */
export async function saveAiConfig(pool: pg.Pool, secretKey: Buffer | null, config: AiConfig | null): Promise<void> {
  if (!config) {
    await setSetting(pool, AI_KEY, null)
    return
  }
  if (config.apiKey && !secretKey) throw new Error("Set INTEGRATOR_SECRET_KEY on the server before saving an API key")
  const stored: StoredAiConfig = {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ? encryptSecret(secretKey!, config.apiKey).toString("base64") : null
  }
  await setSetting(pool, AI_KEY, stored)
}

/**
 * The AI provider from the environment (OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
 * or LLM_BASE_URL with LLM_API_KEY; AGENT_MODEL), which seeds the stored
 * settings once, when none are stored: deploy/setup.sh passes a key this way.
 */
export function aiConfigFromEnv(env: NodeJS.ProcessEnv): AiConfig | null {
  const baseUrl = env.LLM_BASE_URL?.trim().replace(/\/+$/, "") || null
  const model = env.AGENT_MODEL?.trim() || null
  if (baseUrl) return { provider: "custom", model, baseUrl, apiKey: env.LLM_API_KEY || null }
  if (env.OPENROUTER_API_KEY) return { provider: "openrouter", model, baseUrl: null, apiKey: env.OPENROUTER_API_KEY }
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", model, baseUrl: null, apiKey: env.ANTHROPIC_API_KEY }
  return null
}

/** The live provider and model the agents and translation passes call. */
export class AiRuntime {
  private config: AiConfig | null = null
  private inner: LanguageModel | null = null
  private readonly effort: AgentEffort | null

  /**
   * Stable model handle for agents: every property read goes to the current
   * model, so a settings change reaches sessions already constructed. With AI
   * off, any use throws.
   */
  readonly model: LanguageModel

  /** Creates a runtime with AI off; apply() sets the provider. */
  constructor(effort: AgentEffort | null) {
    this.effort = effort
    this.model = new Proxy({}, {
      get: (_target, property) => {
        const inner = this.inner
        if (!inner || typeof inner !== "object") throw new Error("AI features are turned off on this deployment")
        const value = Reflect.get(inner, property)
        return typeof value === "function" ? value.bind(inner) : value
      }
    }) as LanguageModel
  }

  /** Switches to a configuration; null turns AI off. */
  apply(config: AiConfig | null): void {
    this.config = config
    this.inner = config ? buildModel(config, this.effort) : null
  }

  /** True when a provider is configured. */
  configured(): boolean {
    return this.inner !== null
  }

  /** The configured provider kind; null when AI is off. */
  get provider(): AiProvider | null {
    return this.config?.provider ?? null
  }

  /** The effective model id; null when AI is off. */
  get modelId(): string | null {
    return this.config ? effectiveModelId(this.config) : null
  }

  /** The current configuration, key included; server-side use only. */
  get current(): AiConfig | null {
    return this.config
  }

  /**
   * Loads the stored settings. When none are stored and the environment
   * names a provider (aiConfigFromEnv), it is saved as the settings first. A
   * key that cannot be decrypted leaves AI off and logs why.
   */
  static async load(
    pool: pg.Pool,
    secretKey: Buffer | null,
    effort: AgentEffort | null,
    env: NodeJS.ProcessEnv = process.env,
    log: (message: string) => void = console.log
  ): Promise<AiRuntime> {
    const runtime = new AiRuntime(effort)
    const fromEnv = aiConfigFromEnv(env)
    let config: AiConfig | null
    try {
      config = await loadAiConfig(pool, secretKey)
    } catch (err) {
      log(`AI settings could not be read; AI features are off (${err instanceof Error ? err.message : err})`)
      return runtime
    }
    const stored = (await getSetting(pool, AI_KEY)) !== null
    if (!stored && fromEnv?.provider === "custom" && !fromEnv.model) {
      log("LLM_BASE_URL is set without AGENT_MODEL, so it was not copied into Settings; set the AI provider in Settings")
    } else if (!stored && fromEnv) {
      try {
        await saveAiConfig(pool, secretKey, fromEnv)
        config = fromEnv
        log(`AI provider ${fromEnv.provider} copied from the environment into Settings; Settings is authoritative from now on and the AI variables in .env can be removed`)
      } catch (err) {
        log(`AI variables in the environment were not copied into Settings (${err instanceof Error ? err.message : err})`)
      }
    } else if (stored && fromEnv) {
      log("AI variables in the environment are ignored: the provider is set in Settings")
    }
    if (config && config.provider === "custom" && !config.model) {
      log("The saved custom AI endpoint has no model name; AI features are off until one is set in Settings")
      return runtime
    }
    runtime.apply(config)
    return runtime
  }
}

/** Admin view of the runtime's configuration. */
export function aiSettingsView(runtime: AiRuntime, secretKey: Buffer | null): AiSettingsView {
  const config = runtime.current
  return {
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    baseUrl: config?.baseUrl ?? null,
    keySaved: config?.apiKey != null,
    canStoreKeys: secretKey !== null,
    defaults: DEFAULT_MODELS
  }
}

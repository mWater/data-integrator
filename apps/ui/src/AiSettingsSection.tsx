import { FormEvent, useEffect, useState } from "react"
import { AiInfo, AiLimitsView, AiProviderKind, AiSettings, clearAiSettings, getAiLimits, getAiSettings, saveAiLimits, saveAiSettings } from "./api.js"
import { AiDataSent } from "./aiAck.js"
import { SettingsRow } from "./SettingsRow.js"

/** Display name of a provider kind. */
function providerName(provider: AiProviderKind | null): string {
  return provider === "anthropic" ? "Anthropic" : provider === "openrouter" ? "OpenRouter" : ""
}

/** Props for the AI section. */
interface AiSettingsSectionProps {
  /** The deployment's AI wiring, from /api/me */
  ai: AiInfo
  /** True for admins: shows the provider form */
  isAdmin: boolean
  /** Reloads /api/me after the provider changes */
  onChanged: () => void
}

/**
 * Where AI requests go and what they carry, for everyone; admins also choose
 * the provider, key and model here.
 */
export function AiSettingsSection({ ai, isAdmin, onChanged }: AiSettingsSectionProps) {
  return (
    <SettingsRow id="settings-ai" title={T`AI features`} description={T`The integration designer, Explore, and the dashboard builder use a language model. Nothing else does.`}>
      {ai.provider === null ? (
        <p className="settings-value">
          {isAdmin ? T`AI features are off. Choose a provider below to turn them on.` : T`AI features are off. An administrator can turn them on.`}
        </p>
      ) : ai.provider === "custom" ? (
        <p className="settings-value">{T`AI requests go to this deployment's own model endpoint (${ai.model ?? ""}), not to an external provider.`}</p>
      ) : (
        <>
          <p className="settings-value">{T`AI requests go to ${providerName(ai.provider)}, model ${ai.model ?? ""}. Each request can include:`}</p>
          <div className="settings-ai-data"><AiDataSent /></div>
          <p className="dim">{ai.ackRequired ? T`You will be asked to accept this notice before your first AI request.` : T`You have accepted this notice.`}</p>
        </>
      )}
      <p><a href="#/ai-privacy">{T`How AI features handle data`}</a></p>
      {isAdmin && <AiProviderForm onChanged={onChanged} />}
      {isAdmin && ai.provider !== null && <AiLimitsForm />}
    </SettingsRow>
  )
}

/** Admin form: provider, endpoint, key and model, tested on save. */
function AiProviderForm({ onChanged }: { onChanged: () => void }) {
  const [saved, setSaved] = useState<AiSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [provider, setProvider] = useState<AiProviderKind | "off">("off")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function reset(settings: AiSettings) {
    setSaved(settings)
    setProvider(settings.provider ?? "off")
    setBaseUrl(settings.baseUrl ?? "")
    setModel(settings.model ?? "")
    setApiKey("")
  }

  useEffect(() => {
    getAiSettings().then(reset, err => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (loadError) return <div className="error">{loadError}</div>
  if (!saved) return null

  // The saved key is reused only for the provider and endpoint it was entered for
  const keyKept = saved.keySaved && saved.provider === provider && (provider !== "custom" || saved.baseUrl === baseUrl.trim().replace(/\/+$/, ""))
  const needsKey = provider === "openrouter" || provider === "anthropic"
  const blocked = needsKey && !saved.canStoreKeys
  const dirty = provider !== (saved.provider ?? "off") || apiKey !== "" || model.trim() !== (saved.model ?? "") ||
    (provider === "custom" && baseUrl.trim() !== (saved.baseUrl ?? ""))
  const ready = provider === "off" || (!blocked && (!needsKey || apiKey.trim() !== "" || keyKept) &&
    (provider !== "custom" || (baseUrl.trim() !== "" && model.trim() !== "")))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (provider === "off") {
        reset(await clearAiSettings())
        setNotice(T`AI features are off. The saved key was removed.`)
      } else {
        reset(await saveAiSettings({ provider, baseUrl, apiKey, model }))
        setNotice(T`Saved. The provider answered a test request, and AI features use it now.`)
      }
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const defaultModel = provider === "openrouter" ? saved.defaults.openrouter : provider === "anthropic" ? saved.defaults.anthropic : ""
  return (
    <form className="ai-provider-form" onSubmit={submit} autoComplete="off">
      <h4>{T`Model provider`}</h4>
      {error && <div className="error" role="alert">{error}</div>}
      <label>
        {T`Provider`}
        <select value={provider} onChange={e => { setProvider(e.target.value as AiProviderKind | "off"); setNotice(null) }}>
          <option value="off">{T`Off`}</option>
          <option value="openrouter">OpenRouter</option>
          <option value="anthropic">Anthropic</option>
          <option value="custom">{T`Custom endpoint (OpenAI-compatible)`}</option>
        </select>
      </label>
      {provider === "custom" && (
        <label>
          {T`Base URL`}
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" inputMode="url" />
          <span className="dim">{T`For vLLM, Ollama, LiteLLM and similar servers. Requests and data stay on this endpoint.`}</span>
        </label>
      )}
      {provider !== "off" && (
        <label>
          {T`API key`}
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="new-password"
            disabled={blocked}
            placeholder={keyKept ? T`Saved key kept; enter a new one to replace it` : provider === "custom" ? T`Optional` : ""}
          />
          {blocked && <span className="dim">{T`Set INTEGRATOR_SECRET_KEY on the server to save an API key.`}</span>}
        </label>
      )}
      {provider !== "off" && (
        <label>
          {T`Model`}
          <input value={model} onChange={e => setModel(e.target.value)} placeholder={defaultModel} />
          {provider !== "custom" && <span className="dim">{T`Leave blank for the default, ${defaultModel}.`}</span>}
        </label>
      )}
      <div className="settings-actions">
        <button disabled={busy || !dirty || !ready}>
          {busy ? (provider === "off" ? T`Saving…` : T`Testing Connection…`) : provider === "off" ? T`Turn Off AI` : T`Save and Test`}
        </button>
        {notice && <span className="dim" role="status">{notice}</span>}
      </div>
    </form>
  )
}

/** Millions of tokens as an input value; blank for no cap. */
function toMillions(tokens: number | null): string {
  return tokens === null ? "" : String(tokens / 1_000_000)
}

/** Parses an input value in millions of tokens; null for blank, undefined when invalid. */
function fromMillions(value: string): number | null | undefined {
  if (value.trim() === "") return null
  const millions = Number(value)
  if (!Number.isFinite(millions) || millions <= 0) return undefined
  return Math.round(millions * 1_000_000)
}

/** Admin form: daily token caps per user and for the whole deployment. */
function AiLimitsForm() {
  const [view, setView] = useState<AiLimitsView | null>(null)
  const [user, setUser] = useState("")
  const [deployment, setDeployment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function reset(next: AiLimitsView) {
    setView(next)
    setUser(toMillions(next.limits.userDailyTokens))
    setDeployment(toMillions(next.limits.deploymentDailyTokens))
  }

  useEffect(() => {
    getAiLimits().then(reset, err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (!view) return error ? <div className="error">{error}</div> : null

  const userTokens = fromMillions(user)
  const deploymentTokens = fromMillions(deployment)
  const valid = userTokens !== undefined && deploymentTokens !== undefined
  const dirty = user !== toMillions(view.limits.userDailyTokens) || deployment !== toMillions(view.limits.deploymentDailyTokens)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      reset(await saveAiLimits({ userDailyTokens: userTokens, deploymentDailyTokens: deploymentTokens }))
      setNotice(T`Saved.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ai-provider-form" onSubmit={submit}>
      <h4>{T`Daily limits`}</h4>
      <p className="dim">
        {T`Tokens (input plus output, in millions) AI features may use per day, reset at midnight UTC. Leave blank for no limit. Used today: ${(view.usedToday / 1_000_000).toFixed(2)} million.`}
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      <label>
        {T`Per user`}
        <input type="number" min="0" step="any" value={user} onChange={e => setUser(e.target.value)} aria-invalid={userTokens === undefined} />
      </label>
      <label>
        {T`For the whole deployment`}
        <input type="number" min="0" step="any" value={deployment} onChange={e => setDeployment(e.target.value)} aria-invalid={deploymentTokens === undefined} />
      </label>
      <div className="settings-actions">
        <button disabled={busy || !dirty || !valid}>{busy ? T`Saving…` : T`Save Limits`}</button>
        {notice && <span className="dim" role="status">{notice}</span>}
      </div>
    </form>
  )
}

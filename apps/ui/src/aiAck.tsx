/**
 * One-time AI data-processing acknowledgement. When a hosted model provider is
 * configured, the first thing a user sends to any AI surface (designer,
 * assistant, dashboard builder) waits on an accept dialog; the acceptance is
 * recorded per account on the server, which also enforces it. A custom
 * (self-hosted) endpoint never prompts: data stays on the admin's
 * infrastructure.
 */

import { useEffect, useState } from "react"
import { acknowledgeAi, AiInfo } from "./api.js"

/** Provider and acknowledgement state, from the latest /api/me. */
let info: AiInfo | null = null

/** Resolvers of ensureAiAck calls waiting on the open dialog. */
let waiting: ((ok: boolean) => void)[] = []

/** Updates the module state after sign-in or /api/me refresh. */
export function setAiInfo(next: AiInfo | null): void {
  info = next
}

/** Display name of the configured provider. */
export function aiProviderName(): string {
  return info?.provider === "anthropic" ? "Anthropic" : info?.provider === "openrouter" ? "OpenRouter" : ""
}

/**
 * Resolves true when the user may send to the AI: immediately when no
 * acknowledgement is needed, otherwise after they accept the notice dialog.
 * Resolves false when they cancel; callers just abort the send.
 */
export function ensureAiAck(): Promise<boolean> {
  if (!info?.ackRequired) return Promise.resolve(true)
  return new Promise(resolve => {
    waiting.push(resolve)
    window.dispatchEvent(new Event("ai-ack:show"))
  })
}

/** What each AI request can carry, and what it never does. */
export function AiDataSent() {
  return (
    <>
      <ul>
        <li>{T`your messages`}</li>
        <li>{T`table and column names, and the deployment's area of interest`}</li>
        <li>{T`SQL and samples of query results`}</li>
        <li>{T`integration code and run logs`}</li>
      </ul>
      <p>{T`Passwords, API keys, and stored secret values are never sent.`}</p>
    </>
  )
}

/** Settles every waiting send with the user's choice. */
function settle(ok: boolean): void {
  if (ok && info) info = { ...info, ackRequired: false }
  const resolvers = waiting
  waiting = []
  for (const resolve of resolvers) resolve(ok)
}

/**
 * Mounts once in the app shell; shows the acknowledgement dialog whenever a
 * gated send asks for it.
 */
export function AiAckHost() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener("ai-ack:show", show)
    return () => window.removeEventListener("ai-ack:show", show)
  }, [])

  if (!open) return null
  const provider = aiProviderName()

  function cancel() {
    setOpen(false)
    setError(null)
    settle(false)
  }

  async function agree() {
    setBusy(true)
    setError(null)
    try {
      await acknowledgeAi()
      setOpen(false)
      settle(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={cancel} />
      <div className="confirm-dialog ai-ack-dialog" role="dialog" aria-modal="true" aria-label={T`AI features and your data`}>
        <h2>{T`AI features and your data`}</h2>
        <p>
          {T`The AI features (integration designer, Explore, and dashboard builder) work by sending context to an external model provider, ${provider}. Each request can include:`}
        </p>
        <AiDataSent />
        <p>
          <a href="#/ai-privacy" target="_blank" rel="noreferrer">{T`How AI features handle data`}</a>
        </p>
        {error && <div className="error">{error}</div>}
        <div className="confirm-actions">
          <button className="secondary" onClick={cancel} disabled={busy}>
            {T`Cancel`}
          </button>
          <button onClick={() => void agree()} disabled={busy}>
            {T`I Understand`}
          </button>
        </div>
      </div>
    </>
  )
}

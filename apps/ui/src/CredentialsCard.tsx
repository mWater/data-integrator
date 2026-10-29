/**
 * The credentials card in a design session: the agent asked for secrets via
 * request_secrets, and this is where the operator provides them without
 * leaving the session. Admins see a field per name (with copy-from when
 * another integration already holds the same name); editors see what is
 * needed and a way to continue once an admin has saved it. Values go
 * straight to the secrets API and never into the transcript.
 */
import { useEffect, useMemo, useState } from "react"
import {
  checkSessionSecret,
  copySecretValue,
  listAllSecrets,
  listIntegrationSecrets,
  SecretInfo,
  setSecretValue
} from "./api.js"
import { Markdown } from "./Markdown.js"

/** One requested credential, as the agent described it. */
export interface RequestedSecret {
  /** Secret name */
  name: string
  /** What it is for, one line */
  purpose: string
  /** Where to get it: URL or hint */
  help?: string
  /** Integration already holding a value under this name */
  copyFrom?: string | null
  /** True when the agent supplied a check snippet */
  hasCheck: boolean
}

/** Outcome of the agent's check for one credential. */
type CheckState = { kind: "checking" } | { kind: "ok" } | { kind: "failed"; output: string }

/** Props for the credentials card. */
interface CredentialsCardProps {
  /** Design session the request belongs to */
  sessionId: string
  /** Draft integration the secrets attach to */
  integrationId: string
  /** Requested credentials, in the agent's order */
  items: RequestedSecret[]
  /** True for admins: enables saving */
  isAdmin: boolean
  /** Resumes the session with a names-only message once everything is set */
  onResume: (text: string) => void
}

/** The card: request rows, save controls for admins, and the continue step. */
export function CredentialsCard({ sessionId, integrationId, items, isAdmin, onResume }: CredentialsCardProps) {
  const [stored, setStored] = useState<SecretInfo[] | null>(null)
  const [elsewhere, setElsewhere] = useState<SecretInfo[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState(false)
  // True once this card saved or copied a value: only then does the session
  // resume unprompted. Values set elsewhere (or seen after a reload) wait for
  // a click, since a rejected check would otherwise be forgotten.
  const [savedHere, setSavedHere] = useState(false)

  const refresh = () => {
    listIntegrationSecrets(integrationId).then(r => setStored(r.secrets), err => setError(err.message))
    if (isAdmin) {
      listAllSecrets().then(r => setElsewhere(r.secrets.filter(s => s.integrationId !== integrationId)), () => {})
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [integrationId, isAdmin])

  const storedNames = useMemo(() => new Set((stored ?? []).map(s => s.name)), [stored])
  const missing = items.filter(i => !storedNames.has(i.name))
  const allSet = stored !== null && missing.length === 0
  const checking = Object.values(checks).some(c => c.kind === "checking")
  const rejected = items.filter(i => checks[i.name]?.kind === "failed")

  // Everything saved from this card and nothing rejected: hand back to the agent without a click
  useEffect(() => {
    if (savedHere && allSet && !checking && rejected.length === 0 && !resumed && isAdmin) resume()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedHere, allSet, checking, rejected.length])

  async function afterSave(item: RequestedSecret) {
    setSavedHere(true)
    refresh()
    if (!item.hasCheck) return
    setChecks(c => ({ ...c, [item.name]: { kind: "checking" } }))
    try {
      const result = await checkSessionSecret(sessionId, item.name)
      setChecks(c => ({ ...c, [item.name]: result.ok ? { kind: "ok" } : { kind: "failed", output: result.output } }))
    } catch (err) {
      setChecks(c => ({ ...c, [item.name]: { kind: "failed", output: err instanceof Error ? err.message : String(err) } }))
    }
  }

  async function save(item: RequestedSecret) {
    const value = values[item.name] ?? ""
    if (!value) return
    setBusy(item.name)
    setError(null)
    try {
      await setSecretValue(integrationId, item.name, value)
      setValues(v => ({ ...v, [item.name]: "" }))
      await afterSave(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function copy(item: RequestedSecret, from: string) {
    setBusy(item.name)
    setError(null)
    try {
      await copySecretValue(integrationId, item.name, from)
      await afterSave(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="question credentials-card">
      <b>{items.length === 1 ? T`The integration needs a credential` : T`The integration needs credentials`}</b>
      <p className="dim">
        {isAdmin
          ? T`Values are stored encrypted with this integration and never enter the conversation.`
          : T`Only an admin can save these. Ask one to open this session, or the integration's credentials page, then continue.`}
      </p>
      {error && <div className="error">{error}</div>}
      {items.map(item => {
        const isSet = storedNames.has(item.name)
        const check = checks[item.name]
        const sources = elsewhere.filter(s => s.name === item.name)
        const preferred = item.copyFrom && sources.some(s => s.integrationId === item.copyFrom) ? item.copyFrom : null
        return (
          <div className="credential" key={item.name}>
            <div className="credential-head">
              <code>{item.name}</code>
              {check?.kind === "checking" ? (
                <span className="chip">{T`checking…`}</span>
              ) : check?.kind === "ok" ? (
                <span className="chip chip-succeeded">{T`verified`}</span>
              ) : check?.kind === "failed" ? (
                <span className="chip chip-failed" title={check.output}>{T`rejected`}</span>
              ) : isSet ? (
                <span className="chip chip-succeeded">{T`set`}</span>
              ) : (
                <span className="chip chip-failed">{T`missing`}</span>
              )}
            </div>
            <div className="dim credential-about">
              <Markdown text={item.purpose} />
              {item.help && (
                /^https?:\/\//.test(item.help) ? (
                  <a href={item.help} target="_blank" rel="noreferrer">{item.help}</a>
                ) : (
                  <span>{item.help}</span>
                )
              )}
            </div>
            {isAdmin && (
              <div className="credential-editor">
                <textarea
                  rows={1}
                  placeholder={isSet ? T`Paste a new value to replace it` : T`Paste the value`}
                  value={values[item.name] ?? ""}
                  onChange={e => setValues(v => ({ ...v, [item.name]: e.target.value }))}
                  disabled={busy !== null}
                />
                <button disabled={busy !== null || !(values[item.name] ?? "")} onClick={() => void save(item)}>
                  {busy === item.name ? T`Saving…` : T`Save`}
                </button>
                {!isSet && preferred && (
                  <button className="secondary" disabled={busy !== null} onClick={() => void copy(item, preferred)}>
                    {T`Copy from ${preferred}`}
                  </button>
                )}
                {!isSet && !preferred && sources.length > 0 && (
                  <select defaultValue="" disabled={busy !== null} aria-label={T`Copy ${item.name} from another integration`} onChange={e => e.target.value && void copy(item, e.target.value)}>
                    <option value="" disabled>{T`Copy from…`}</option>
                    {sources.map(s => (
                      <option key={s.integrationId} value={s.integrationId}>{s.integrationId}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {check?.kind === "failed" && <div className="error">{lastLine(check.output)}</div>}
          </div>
        )
      })}
      {isAdmin ? (
        // Saving is the action and the session resumes on its own. A click is
        // only needed to override a rejected check, or when the values were
        // already in place before the card opened.
        allSet && !checking && !resumed && (
          rejected.length > 0 ? (
            <div className="credentials-foot">
              <span className="dim">{T`The check failed. Replace the value, or continue with it as saved.`}</span>
              <button className="secondary" onClick={resume}>{T`Continue Anyway`}</button>
            </div>
          ) : !savedHere ? (
            <div className="credentials-foot">
              <span className="dim">{T`Every value is already set.`}</span>
              <button onClick={resume}>{T`Continue`}</button>
            </div>
          ) : null
        )
      ) : (
        <div className="credentials-foot">
          <a href={`#/integration/${integrationId}`}>{T`Open the credentials page`}</a>
          <button disabled={!allSet || resumed} onClick={resume}>{T`Continue`}</button>
        </div>
      )}
    </div>
  )

  function resume() {
    setResumed(true)
    onResume(`Credentials saved: ${items.map(i => i.name).join(", ")}`)
  }
}

/** The last non-empty line of a check's output: for a traceback, the exception message. */
function lastLine(output: string): string {
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ""
}

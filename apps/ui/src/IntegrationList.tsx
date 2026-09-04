import { useEffect, useMemo, useRef, useState } from "react"
import { createSession, importIntegration, IntegrationSummary, listIntegrations, listSessions, SessionSummary } from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { cronText, formatDateTime, localizeData } from "./localization.js"

/** Human-readable trigger summary. */
export function triggerLabel(trigger: { cron?: string; webhook?: boolean }): string {
  const parts = []
  if (trigger.cron) parts.push(cronText(trigger.cron))
  if (trigger.webhook) parts.push(T`webhook`)
  return parts.join(" + ") || T`manual`
}

/** Props for the integration list. */
interface IntegrationListProps {
  /** False for viewers: hides the new-integration flow */
  canDesign: boolean
}

/** Landing page: installed integrations plus the new-integration flow. */
export function IntegrationList({ canDesign }: IntegrationListProps) {
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null)
  const [drafts, setDrafts] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listIntegrations().then(r => setIntegrations(r.integrations), err => setError(err.message))
    // Design sessions still in progress show here as drafts, so a paused
    // session is found where its result would appear
    listSessions().then(
      // Sessions opened and never used are not drafts worth listing
      r =>
        setDrafts(
          r.sessions.filter(s => s.kind === "designer" && s.status !== "finished" && (s.steps > 0 || s.firstMessage))
        ),
      () => {}
    )
  }, [])

  // Drafts whose integration already has a row are reachable from that row
  const orphanDrafts = useMemo(
    () => drafts.filter(d => !d.integrationId || !(integrations ?? []).some(i => i.id === d.integrationId)),
    [drafts, integrations]
  )

  const sortedIntegrations = useMemo(
    () =>
      (integrations ?? [])
        .slice()
        .sort(
          (a, b) =>
            localizeData(a.name).localeCompare(localizeData(b.name), undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id, undefined, { sensitivity: "base" })
        ),
    [integrations]
  )

  /** Imports a definition file exported by another deployment; it lands paused. */
  async function onImportFile(file: File) {
    setError(null)
    try {
      const definition = JSON.parse(await file.text())
      const { id } = await importIntegration(definition)
      window.location.hash = `#/integration/${id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onCreate() {
    setError(null)
    if (!(await ensureAiAck())) return
    try {
      const { sessionId } = await createSession()
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="list-page">
      <div className="list-head">
        <h1>{T`Integrations`}</h1>
        {canDesign && (
          <div className="list-head-actions">
            <button
              className="secondary"
              title={T`Install a definition file exported from another deployment; it arrives paused for review`}
              onClick={() => fileInput.current?.click()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 1.5v6M3.5 5 6 7.5 8.5 5M2 10.5h8" />
              </svg>
              {T`Import`}
            </button>
            <button onClick={onCreate}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 1.5v9M1.5 6h9" />
              </svg>
              {T`New Integration`}
            </button>
          </div>
        )}
      </div>
      {canDesign && (
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void onImportFile(file)
          }}
        />
      )}
      {error && <div className="error">{error}</div>}
      {integrations === null ? (
        <p>{T`Loading…`}</p>
      ) : integrations.length === 0 && orphanDrafts.length === 0 ? (
        <p>{T`Nothing installed yet. New Integration starts a design session; describe what to build there.`}</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>{T`Integration`}</th><th>{T`Trigger`}</th><th>{T`Last run`}</th></tr>
          </thead>
          <tbody>
            {orphanDrafts.map(d => (
              <tr key={`draft-${d.id}`} onClick={() => (window.location.hash = `#/session/${d.id}`)}>
                <td>
                  <b>{d.integrationId ?? d.firstMessage ?? T`(new)`}</b>
                  <span className="chip chip-draft">{T`draft`}</span>
                  <div className="dim">{d.status === "paused" ? T`Design session paused, waiting for you` : T`Design session in progress`}</div>
                </td>
                <td />
                <td><span className="dim">{formatDateTime(d.updatedAt)}</span></td>
              </tr>
            ))}
            {sortedIntegrations.map(i => (
              <tr key={i.id} onClick={() => (window.location.hash = `#/integration/${i.id}`)}>
                <td>
                  <b>{localizeData(i.name)}</b>
                  {i.status === "draft" && <span className="chip chip-draft">{T`draft`}</span>}
                  {!i.enabled && <span className="chip chip-paused integration-state-chip">{T`paused`}</span>}
                  {i.description && <div className="dim clamp-2">{localizeData(i.description)}</div>}
                  <div className="dim">{i.id}</div>
                </td>
                <td>{triggerLabel(i.trigger)}</td>
                <td>
                  {i.lastRunStatus ? (
                    <>
                      <span className={`chip chip-${i.lastRunStatus}`}>{i.lastRunStatus}</span>{" "}
                      <span className="dim">{i.lastRunAt ? formatDateTime(i.lastRunAt) : ""}</span>
                    </>
                  ) : (
                    <span className="dim">{T`never`}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

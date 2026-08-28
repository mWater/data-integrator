import { useEffect, useRef, useState } from "react"
import { createSession, importIntegration, IntegrationSummary, listIntegrations, listSessions } from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { cronText } from "./localization.js"

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
  const [openSessions, setOpenSessions] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listIntegrations().then(r => setIntegrations(r.integrations), err => setError(err.message))
    listSessions().then(
      r => setOpenSessions(r.sessions.filter(s => s.status !== "finished").length),
      () => {}
    )
  }, [])

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
      <h1>{T`Integrations`}</h1>
      {canDesign && (
        <div className="new-session">
          <button onClick={onCreate}>{T`New Integration`}</button>
          <button
            className="secondary"
            title={T`Install a definition file exported from another deployment; it arrives paused for review`}
            onClick={() => fileInput.current?.click()}
          >
            {T`Import`}
          </button>
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
          <a className="dim-link" href="#/sessions">
            {openSessions > 0 ? T`Agent activity (${openSessions} open)` : T`Agent activity`}
          </a>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {integrations === null ? (
        <p>{T`Loading…`}</p>
      ) : integrations.length === 0 ? (
        <p>{T`Nothing installed yet. New Integration starts a design session; describe what to build there.`}</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>{T`Integration`}</th><th>{T`Trigger`}</th><th>{T`Last run`}</th></tr>
          </thead>
          <tbody>
            {integrations.map(i => (
              <tr key={i.id} onClick={() => (window.location.hash = `#/integration/${i.id}`)}>
                <td>
                  <b>{i.name}</b>
                  {i.status === "draft" && <span className="chip chip-draft">{T`draft`}</span>}
                  <div className="dim">{i.id}</div>
                </td>
                <td>{triggerLabel(i.trigger)}</td>
                <td>
                  {i.lastRunStatus ? (
                    <>
                      <span className={`chip chip-${i.lastRunStatus}`}>{i.lastRunStatus}</span>{" "}
                      <span className="dim">{i.lastRunAt ? new Date(i.lastRunAt).toLocaleString() : ""}</span>
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

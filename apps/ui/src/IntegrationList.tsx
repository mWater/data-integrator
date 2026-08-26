import { useEffect, useState } from "react"
import { createSession, IntegrationSummary, listIntegrations, listSessions } from "./api.js"
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

  useEffect(() => {
    listIntegrations().then(r => setIntegrations(r.integrations), err => setError(err.message))
    listSessions().then(
      r => setOpenSessions(r.sessions.filter(s => s.status !== "finished").length),
      () => {}
    )
  }, [])

  async function onCreate() {
    setError(null)
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

import { useEffect, useState } from "react"
import cronstrue from "cronstrue"
import { createSession, IntegrationSummary, listIntegrations, listSessions } from "./api.js"

/** Human-readable trigger summary. */
export function triggerLabel(trigger: { cron?: string; webhook?: boolean }): string {
  const parts = []
  if (trigger.cron) parts.push(cronText(trigger.cron))
  if (trigger.webhook) parts.push("webhook")
  return parts.join(" + ") || "manual"
}

/** Cron expression in plain language; unparseable expressions stay raw. */
function cronText(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true })
  } catch {
    return `cron ${cron}`
  }
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
      <h1>Integrations</h1>
      {canDesign && (
        <div className="new-session">
          <button onClick={onCreate}>New Integration</button>
          <a className="dim-link" href="#/sessions">
            Agent activity{openSessions > 0 ? ` (${openSessions} open)` : ""}
          </a>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {integrations === null ? (
        <p>Loading…</p>
      ) : integrations.length === 0 ? (
        <p>Nothing installed yet. New Integration starts a design session; describe what to build there.</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>Integration</th><th>Runtime</th><th>Trigger</th><th>Last run</th></tr>
          </thead>
          <tbody>
            {integrations.map(i => (
              <tr key={i.id} onClick={() => (window.location.hash = `#/integration/${i.id}`)}>
                <td>
                  <b>{i.name}</b>
                  {i.status === "draft" && <span className="chip chip-draft">draft</span>}
                  <div className="dim">{i.id}</div>
                </td>
                <td>{i.runtime}</td>
                <td>{triggerLabel(i.trigger)}</td>
                <td>
                  {i.lastRunStatus ? (
                    <>
                      <span className={`chip chip-${i.lastRunStatus}`}>{i.lastRunStatus}</span>{" "}
                      <span className="dim">{i.lastRunAt ? new Date(i.lastRunAt).toLocaleString() : ""}</span>
                    </>
                  ) : (
                    <span className="dim">never</span>
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

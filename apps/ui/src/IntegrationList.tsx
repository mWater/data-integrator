import { FormEvent, useEffect, useState } from "react"
import { createSession, IntegrationSummary, listIntegrations } from "./api.js"

/** Human-readable trigger summary. */
export function triggerLabel(trigger: { cron?: string; webhook?: boolean }): string {
  const parts = []
  if (trigger.cron) parts.push(`cron ${trigger.cron}`)
  if (trigger.webhook) parts.push("webhook")
  return parts.join(" + ") || "manual"
}

/** Landing page: installed integrations plus the new-integration flow. */
export function IntegrationList() {
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null)
  const [newId, setNewId] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listIntegrations().then(r => setIntegrations(r.integrations), err => setError(err.message))
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const { sessionId } = await createSession(newId.trim())
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="list-page">
      <h1>Integrations</h1>
      <form className="new-session" onSubmit={onCreate}>
        <input
          value={newId}
          onChange={e => setNewId(e.target.value)}
          placeholder="new integration id (snake_case)"
          pattern="[a-z][a-z0-9_]*"
          required
        />
        <button type="submit">New Integration</button>
      </form>
      {error && <div className="error">{error}</div>}
      {integrations === null ? (
        <p>Loading…</p>
      ) : integrations.length === 0 ? (
        <p>Nothing installed yet. Name an integration to start a design session.</p>
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

import { FormEvent, useEffect, useState } from "react"
import { createSession, listSessions, SessionSummary } from "./api.js"

/** Session list page with a new-session form. */
export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [integrationId, setIntegrationId] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSessions().then(r => setSessions(r.sessions), err => setError(err.message))
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const { sessionId } = await createSession(integrationId.trim())
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="list-page">
      <h1>Design sessions</h1>
      <form className="new-session" onSubmit={onCreate}>
        <input
          value={integrationId}
          onChange={e => setIntegrationId(e.target.value)}
          placeholder="integration id (snake_case)"
          pattern="[a-z][a-z0-9_]*"
          required
        />
        <button type="submit">New Session</button>
      </form>
      {error && <div className="error">{error}</div>}
      {sessions === null ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p>No sessions yet. Name an integration and start designing.</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>Integration</th><th>Status</th><th>Steps</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                <td>{s.integrationId ?? "?"}</td>
                <td><span className={`chip chip-${s.status}`}>{s.status}</span></td>
                <td>{s.steps}</td>
                <td>{new Date(s.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

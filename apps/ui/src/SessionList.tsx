import { useEffect, useState } from "react"
import { listSessions, SessionSummary } from "./api.js"

/** Human labels for session statuses (statuses stay technical in the API). */
const STATUS_LABEL: Record<string, string> = {
  active: "working",
  paused: "waiting for you",
  finished: "done"
}

/** Agent activity page: past and in-progress design sessions, newest first. */
export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSessions().then(r => setSessions(r.sessions), err => setError(err.message))
  }, [])

  return (
    <main className="list-page">
      <h1>Agent activity</h1>
      {error && <div className="error">{error}</div>}
      {sessions === null ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p>No design sessions yet. Start one with New Integration on the Integrations page.</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>Integration</th><th>Status</th><th>Steps</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                <td>{s.integrationId ?? <span className="dim">{s.firstMessage ?? "(new)"}</span>}</td>
                <td><span className={`chip chip-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
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

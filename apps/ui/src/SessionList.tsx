import { useEffect, useState } from "react"
import { listSessions, SessionSummary } from "./api.js"

/** Human labels for session statuses (statuses stay technical in the API). */
function statusLabels(): Record<string, string> {
  return {
    active: T`working`,
    paused: T`waiting for you`,
    finished: T`done`
  }
}

/** Agent activity page: past and in-progress design sessions, newest first. */
export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Assistant chats live on the Assistant page; this list is design work
    listSessions().then(r => setSessions(r.sessions.filter(s => s.kind !== "assistant")), err => setError(err.message))
  }, [])

  return (
    <main className="list-page">
      <h1>{T`Agent activity`}</h1>
      {error && <div className="error">{error}</div>}
      {sessions === null ? (
        <p>{T`Loading…`}</p>
      ) : sessions.length === 0 ? (
        <p>{T`No design sessions yet. Start one with New Integration on the Integrations page.`}</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>{T`Integration`}</th><th>{T`Status`}</th><th>{T`Steps`}</th><th>{T`Updated`}</th></tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                <td>{s.integrationId ?? <span className="dim">{s.firstMessage ?? T`(new)`}</span>}</td>
                <td><span className={`chip chip-${s.status}`}>{statusLabels()[s.status] ?? s.status}</span></td>
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

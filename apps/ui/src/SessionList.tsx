import { LoadState } from "./LoadState.js"
import { useEffect, useState } from "react"
import { listSessions, SessionSummary } from "./api.js"
import { formatDateTime } from "./localization.js"

/** Human labels for session statuses (statuses stay technical in the API). */
function statusLabels(): Record<string, string> {
  return {
    active: T`working`,
    paused: T`waiting for you`,
    finished: T`done`
  }
}

/** What a session is building: the integration id or dashboard name, else its opening message. */
function sessionTitle(s: SessionSummary): string {
  if (s.kind === "dashboard") return s.label || s.firstMessage || T`New dashboard`
  return s.integrationId ?? s.firstMessage ?? T`(new)`
}

/** Agent activity page: past and in-progress design sessions, newest first. */
export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    setError(null)
    // Questions live on the Explore page; this list is design work
    listSessions().then(r => setSessions(r.sessions.filter(s => s.kind !== "assistant")), err => setError(err.message))
  }, [retry])

  return (
    <main className="list-page">
      <h1>{T`Agent activity`}</h1>
      {error && sessions !== null && <div className="error" role="alert">{error}</div>}
      {sessions === null ? (
        <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
      ) : sessions.length === 0 ? (
        <p>{T`No design sessions yet. Start one with New Integration on the Integrations page or New Dashboard on the Dashboards page.`}</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>{T`What`}</th><th>{T`Kind`}</th><th>{T`Status`}</th><th>{T`Steps`}</th><th>{T`Updated`}</th></tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                <td><a href={`#/session/${s.id}`} onClick={e => e.stopPropagation()}>{sessionTitle(s)}</a></td>
                <td><span className="chip">{s.kind === "dashboard" ? T`dashboard` : T`integration`}</span></td>
                <td><span className={`chip chip-${s.status}`}>{statusLabels()[s.status] ?? s.status}</span></td>
                <td>{s.steps}</td>
                <td>{formatDateTime(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

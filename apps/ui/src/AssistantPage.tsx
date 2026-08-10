/**
 * The assistant page: a compose-first welcome screen (no blank chat) plus the
 * list of past conversations. Available to every role; the assistant is
 * read-only by construction.
 */

import { useEffect, useState } from "react"
import { createAssistantSession, listSessions, sendMessage, SessionSummary } from "./api.js"
import { WelcomeCompose } from "./WelcomeCompose.js"

/** Human labels for session statuses. */
const STATUS_LABEL: Record<string, string> = {
  active: "working",
  paused: "ready",
  finished: "done"
}

/** Example questions; deployment-neutral so they hold for any installed data. */
const HINTS = [
  "What data is available?",
  "Chart monthly rainfall for the last 12 months"
]

/** The Ask-about-the-data page: welcome composer + past conversations. */
export function AssistantPage() {
  const [chats, setChats] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSessions().then(
      r => setChats(r.sessions.filter(s => s.kind === "assistant")),
      err => setError(err.message)
    )
  }, [])

  async function start(text: string) {
    const { sessionId } = await createAssistantSession()
    await sendMessage(sessionId, text)
    window.location.hash = `#/session/${sessionId}`
  }

  return (
    <main className="list-page assistant-page">
      <WelcomeCompose
        icon={
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.3 0-2.6-.3-3.7-.9L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5Z" />
            <path d="M8 10.5h8M8 14h5" />
          </svg>
        }
        title="Ask about the data"
        blurb="Plain-language questions, answered from the platform's ingested data with tables, charts, and maps - every answer carries its SQL and a CSV download."
        placeholder={
          "Describe the data you want, e.g.:\n" +
          "rainfall and groundwater levels for southern Madagascar over the last 6 months\n\n" +
          "Name the place, the period, and the measurements you care about."
        }
        hints={HINTS}
        submitLabel="Ask"
        onSubmit={start}
      />
      {error && <div className="error">{error}</div>}
      {chats !== null && chats.length > 0 && (
        <section className="assistant-history">
          <h2>Past conversations</h2>
          <table className="sessions">
            <thead>
              <tr><th>Question</th><th>Status</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {chats.map(s => (
                <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                  <td>{s.firstMessage ?? <span className="dim">(empty)</span>}</td>
                  <td><span className={`chip chip-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
                  <td>{new Date(s.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}

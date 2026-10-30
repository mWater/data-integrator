import { LoadState } from "./LoadState.js"
/**
 * The assistant page: a compose-first welcome screen (no blank chat) plus the
 * list of past conversations. Available to every role; the assistant is
 * read-only by construction.
 */

import { useEffect, useState } from "react"
import { createAssistantSession, deleteSession, listSessions, sendMessage, SessionSummary } from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { ConfirmDelete } from "./ConfirmDelete.js"
import { WelcomeCompose } from "./WelcomeCompose.js"
import { formatDateTime } from "./localization.js"

/** Human labels for session statuses. */
function statusLabels(): Record<string, string> {
  return {
    active: T`working`,
    paused: T`ready`,
    finished: T`done`
  }
}

/** Example questions; deployment-neutral so they hold for any installed data. */
function hints(): string[] {
  return [
    T`What data is available?`,
    T`Chart monthly rainfall for the last 12 months`
  ]
}

/** Trash icon for the per-row delete action. */
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  )
}

/** The Explore page: welcome composer + past conversations. */
export function AssistantPage() {
  const [chats, setChats] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [doomed, setDoomed] = useState<SessionSummary | null>(null)

  useEffect(() => {
    setError(null)
    listSessions().then(
      r => setChats(r.sessions.filter(s => s.kind === "assistant")),
      err => setError(err.message)
    )
  }, [retry])

  async function confirmDelete(chat: SessionSummary) {
    setDoomed(null)
    setError(null)
    try {
      await deleteSession(chat.id)
      setChats(current => (current ?? []).filter(c => c.id !== chat.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function start(text: string) {
    if (!(await ensureAiAck())) return
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
        title={T`Explore the data`}
        blurb={T`Plain-language questions, answered from the platform's ingested data with tables, charts, and maps - every answer carries its SQL and a CSV download.`}
        placeholder={T`Describe the data you want, e.g.:
rainfall and groundwater levels for the northern districts over the last 6 months

Name the place, the period, and the measurements you care about.`}
        hints={hints()}
        submitLabel={T`Explore`}
        onSubmit={start}
      />
      {error && chats !== null && <div className="error" role="alert">{error}</div>}
      <section className="assistant-history">
        <h2>{T`Past questions`}</h2>
        {chats === null ? (
          <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
        ) : chats.length === 0 ? (
          <p className="dim">{T`No questions yet. Ask one above; it is saved here.`}</p>
        ) : (
          <table className="sessions">
            <thead>
              <tr><th>{T`Question`}</th><th>{T`Status`}</th><th>{T`Updated`}</th><th /></tr>
            </thead>
            <tbody>
              {chats.map(s => (
                <tr key={s.id} onClick={() => (window.location.hash = `#/session/${s.id}`)}>
                  <td><a href={`#/session/${s.id}`} onClick={e => e.stopPropagation()}>{s.firstMessage ?? T`(empty)`}</a></td>
                  <td><span className={`chip chip-${s.status}`}>{statusLabels()[s.status] ?? s.status}</span></td>
                  <td>{formatDateTime(s.updatedAt)}</td>
                  <td className="row-delete-cell">
                    <button
                      className="row-delete"
                      title={T`Delete question`}
                      aria-label={T`Delete question: ${s.firstMessage ?? T`(empty)`}`}
                      // The row navigates; the delete must not ride along
                      onClick={e => {
                        e.stopPropagation()
                        setDoomed(s)
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {doomed && (
        <ConfirmDelete
          title={T`Delete this question?`}
          confirmLabel={T`Delete`}
          onCancel={() => setDoomed(null)}
          onConfirm={() => void confirmDelete(doomed)}
        >
          <p>
            {doomed.firstMessage
              ? T`“${doomed.firstMessage}” and its answers, tables, and charts are deleted for good.`
              : T`This question and its answers, tables, and charts are deleted for good.`}{" "}
            <b>{T`This cannot be undone.`}</b>
          </p>
        </ConfirmDelete>
      )}
    </main>
  )
}

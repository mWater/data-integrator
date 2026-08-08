import { FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { activityLabel } from "./activity.js"
import { getSession, sendMessage, SessionDetail, SessionEvent, stopSession, subscribeEvents } from "./api.js"
import { Markdown } from "./Markdown.js"
import { Transcript } from "./Transcript.js"
import { StatePanel } from "./StatePanel.js"

/** One live item rendered below the stored transcript while the loop runs. */
export interface LiveItem {
  /** Item kind mirrors event types */
  kind: "user" | "assistant" | "tool"
  /** Text for user/assistant items */
  text?: string
  /** Tool name for tool items */
  tool?: string
  /** Tool input preview */
  input?: unknown
  /** Result prefix once the tool ends */
  summary?: string
  /** Streamed job log lines for tool items */
  logs: string[]
  /** True while the tool is still executing */
  open: boolean
}

/** A structured question awaiting the user's answer. */
interface PendingQuestion {
  /** Question text (markdown) */
  question: string
  /** Selectable answers */
  options: string[]
}

/**
 * The unanswered ask_user question, if the transcript ends with one: the last
 * ask_user tool call with no user message after it.
 */
function pendingQuestion(detail: SessionDetail): PendingQuestion | null {
  let pending: PendingQuestion | null = null
  for (const message of detail.messages) {
    if (message.role === "user") pending = null
    else if (message.role === "assistant" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === "ask_user") {
          const input = part.input as { question?: unknown; options?: unknown[] } | undefined
          const options = Array.isArray(input?.options) ? input.options.map(String) : []
          if (input?.question && options.length >= 2) pending = { question: String(input.question), options }
        }
      }
    }
  }
  return pending
}

/** Props for the session view. */
interface SessionViewProps {
  /** Session to display */
  sessionId: string
  /** False for viewers: composer is read-only */
  canDesign: boolean
}

/** One design session: transcript + live stream on the left, state panel on the right. */
export function SessionView({ sessionId, canDesign }: SessionViewProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [liveId, setLiveId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveItem[]>([])
  const [busy, setBusy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    getSession(sessionId).then(d => {
      setDetail(d)
      setBusy(d.running)
    }, err => setError(err.message))
  }, [sessionId])

  useEffect(() => {
    refresh()
    return subscribeEvents(sessionId, event => onEvent(event))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /** Folds one SSE event into the live item list. */
  function onEvent(event: SessionEvent) {
    if (event.type === "integration_bound") {
      setLiveId(event.integrationId ?? null)
      return
    }
    if (event.type === "stop" || event.type === "error") {
      setLive([])
      setBusy(false)
      setStopping(false)
      if (event.type === "error") setError(event.message ?? "unknown error")
      refresh()
      return
    }
    setLive(items => {
      const next = [...items]
      if (event.type === "user_message") next.push({ kind: "user", text: event.text, logs: [], open: false })
      else if (event.type === "assistant_text") next.push({ kind: "assistant", text: event.text, logs: [], open: false })
      else if (event.type === "tool_start")
        next.push({ kind: "tool", tool: event.tool, input: event.input, logs: [], open: true })
      else if (event.type === "tool_end") {
        const item = next.findLast(i => i.kind === "tool" && i.tool === event.tool && i.open)
        if (item) {
          item.open = false
          item.summary = event.summary
        }
      } else if (event.type === "job_log") {
        const item = next.findLast(i => i.kind === "tool" && i.open)
        if (item) item.logs = [...item.logs.slice(-199), event.line ?? ""]
      }
      return next
    })
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [live, detail])

  async function send(text: string) {
    if (!text) return
    setError(null)
    const wasBusy = busy
    setBusy(true)
    setInput("")
    try {
      await sendMessage(sessionId, text)
    } catch (err) {
      if (!wasBusy) setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function onSend(e: FormEvent) {
    e.preventDefault()
    void send(input.trim())
  }

  async function onStop() {
    setStopping(true)
    try {
      await stopSession(sessionId)
    } catch (err) {
      setStopping(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!detail) return <main className="session-page">{error ? <div className="error">{error}</div> : "Loading…"}</main>

  const finished = detail.status === "finished"
  const question = !busy && canDesign && detail.status === "paused" ? pendingQuestion(detail) : null
  return (
    <main className="session-page">
      <div className="conversation">
        <div className="session-head">
          <h1>{detail.integrationId ?? liveId ?? "New integration"}</h1>
          {detail.certified && <span className="chip chip-certified">cold-run certified</span>}
          {detail.scratchLayers.length > 0 && <a href={`#/map?session=${detail.id}`}>Map preview</a>}
          <span className="spacer" />
          <button className="details-toggle" onClick={() => setShowDetails(v => !v)}>
            {showDetails ? "Hide details" : "Details"}
          </button>
        </div>
        <div className="messages">
          <Transcript messages={detail.messages} hideTrailingQuestion={question != null} />
          {live.map((item, i) => (
            <LiveBlock key={i} item={item} />
          ))}
          {busy && !live.some(i => i.kind === "tool" && i.open) && (
            <div className="thinking">
              <span className="spinner" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {question && <QuestionCard question={question} onAnswer={text => void send(text)} />}
        {error && <div className="error">{error}</div>}
        {!error && !busy && detail.error && (
          <div className="error">The agent hit an error and stopped: {detail.error} — send a message to retry.</div>
        )}
        <form className="composer" onSubmit={onSend}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={
              !canDesign
                ? "Viewers can watch but not send"
                : finished
                  ? "Session finished"
                  : busy
                    ? "Steer the agent — your message lands after the current step…"
                    : "Describe what to build or change…"
            }
            disabled={!canDesign || finished}
            rows={3}
          />
          {busy && input.trim() === "" ? (
            <button type="button" className="stop" onClick={() => void onStop()} disabled={!canDesign || stopping}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button type="submit" disabled={!canDesign || finished || !input.trim()}>Send</button>
          )}
        </form>
      </div>
      {showDetails && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowDetails(false)} />
          <div className="details-drawer">
            <button className="drawer-close" onClick={() => setShowDetails(false)} aria-label="Close details">
              ×
            </button>
            <StatePanel detail={detail} />
          </div>
        </>
      )}
    </main>
  )
}

/** Props for a live block. */
interface LiveBlockProps {
  /** Item to render */
  item: LiveItem
}

/** Renders one in-flight item: user echo, assistant text, or a subtle activity line. */
function LiveBlock({ item }: LiveBlockProps) {
  if (item.kind === "user") return <div className="msg msg-user">{item.text}</div>
  if (item.kind === "assistant") return <Markdown className="msg msg-assistant" text={item.text ?? ""} />
  if (item.tool === "ask_user") return null // the question card is the rendering
  return (
    <div className="activity-block">
      <div className="activity">
        {activityLabel(item.tool, item.input, item.open)}
        {item.open && <span className="spinner" />}
      </div>
      {item.open && item.logs.length > 0 && <pre className="tool-logs">{item.logs.join("\n")}</pre>}
    </div>
  )
}

/** Props for the pending-question card. */
interface QuestionCardProps {
  /** The unanswered question */
  question: PendingQuestion
  /** Sends the chosen or typed answer */
  onAnswer: (text: string) => void
}

/** The pending question: option rows plus a client-side "Other" free-text answer. */
function QuestionCard({ question, onAnswer }: QuestionCardProps) {
  const [other, setOther] = useState(false)
  const [text, setText] = useState("")
  return (
    <div className="question">
      <Markdown text={question.question} />
      <div className="question-options">
        {question.options.map(option => (
          <button key={option} onClick={() => onAnswer(option)}>{option}</button>
        ))}
        {other ? (
          <form
            className="question-other"
            onSubmit={e => {
              e.preventDefault()
              if (text.trim()) onAnswer(text.trim())
            }}
          >
            <input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="Other…" />
            <button type="submit" disabled={!text.trim()}>Send</button>
          </form>
        ) : (
          <button className="question-other-toggle" onClick={() => setOther(true)}>Other…</button>
        )}
      </div>
    </div>
  )
}

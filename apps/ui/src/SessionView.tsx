import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react"
import { activityLabel } from "./activity.js"
import {
  DashboardAgentState,
  DesignerState,
  execSessionQuery,
  getSession,
  sendMessage,
  SessionDetail,
  SessionEvent,
  stopSession,
  subscribeEvents
} from "./api.js"
import { DashboardFrame, fetchTileBytes } from "./DashboardFrame.js"
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

/**
 * Collapses adjacent live tool items that render the same label, matching the
 * stored transcript. A running call labels itself differently from a finished
 * one, so the in-flight item stays its own row until it completes and merges.
 */
function toLiveGroups(items: LiveItem[]): LiveItem[][] {
  const groups: LiveItem[][] = []
  for (const item of items) {
    const last = groups.at(-1)
    const mergeable =
      item.kind === "tool" &&
      last?.[0].kind === "tool" &&
      activityLabel(last[0].tool, last[0].input, last[0].open) === activityLabel(item.tool, item.input, item.open)
    if (mergeable) last.push(item)
    else groups.push([item])
  }
  return groups
}

/** Preview panel width as a fraction of the page, persisted across sessions. */
const SPLIT_KEY = "di.sessionSplit"

/** Default preview share of the page width. */
const SPLIT_DEFAULT = 0.55

/** Narrowest either side may be dragged, as a fraction of the page. */
const SPLIT_MIN = 0.2

/** Reads the persisted split fraction, falling back to the default. */
function storedSplit(): number {
  const raw = Number(localStorage.getItem(SPLIT_KEY))
  return raw >= SPLIT_MIN && raw <= 1 - SPLIT_MIN ? raw : SPLIT_DEFAULT
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
  const [live, setLive] = useState<LiveItem[]>([])
  const [busy, setBusy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [previewErrors, setPreviewErrors] = useState<string[]>([])
  const [split, setSplit] = useState(storedSplit)
  const pageRef = useRef<HTMLElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const kindRef = useRef<string | null>(null)
  // While the loop runs, the stored transcript is rendered only up to this
  // message count; the live event overlay covers everything newer. Mid-loop
  // refreshes persist steps into detail.messages, so without the cut the same
  // message renders twice (stored + live) until the loop ends.
  const frozenRef = useRef<number | null>(null)

  const refresh = useCallback(() => {
    getSession(sessionId).then(d => {
      kindRef.current = d.kind
      if (d.running && frozenRef.current == null) frozenRef.current = d.messages.length
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
    // The bound artifact's display name lives in the session state, not the event
    if (event.type === "integration_bound") {
      refresh()
      return
    }
    if (event.type === "stop" || event.type === "error") {
      frozenRef.current = null
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
        // Dashboard sessions: state (draft, build) changes with tool results,
        // so refetch to keep the live preview current mid-loop
        if (kindRef.current === "dashboard") refresh()
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
    if (!wasBusy) frozenRef.current = detail?.messages.length ?? 0
    setBusy(true)
    setInput("")
    // Preview runtime errors ride along with the next message so the agent
    // hears about crashes without the user pasting them
    let outgoing = text
    if (previewErrors.length > 0) {
      outgoing = `[The dashboard preview reported runtime errors since the last build:]\n${previewErrors.join("\n")}\n\n${text}`
      setPreviewErrors([])
    }
    try {
      await sendMessage(sessionId, outgoing)
    } catch (err) {
      if (!wasBusy) {
        setBusy(false)
        frozenRef.current = null
      }
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function onSend(e: FormEvent) {
    e.preventDefault()
    void send(input.trim())
  }

  /** Drags the divider; the split persists so it survives navigation. */
  function onSplitDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const page = pageRef.current
    if (!page) return
    const handle = e.currentTarget
    handle.classList.add("dragging")
    document.body.classList.add("col-resizing")

    const onMove = (move: PointerEvent) => {
      const box = page.getBoundingClientRect()
      const fraction = (box.right - move.clientX) / box.width
      setSplit(Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, fraction)))
    }
    const onUp = () => {
      handle.classList.remove("dragging")
      document.body.classList.remove("col-resizing")
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setSplit(current => {
        localStorage.setItem(SPLIT_KEY, String(current))
        return current
      })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  /** Double-click restores the default split. */
  function onSplitReset() {
    setSplit(SPLIT_DEFAULT)
    localStorage.setItem(SPLIT_KEY, String(SPLIT_DEFAULT))
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

  if (!detail)
    return (
      <main className="session-page" ref={pageRef}>
        {error ? <div className="error">{error}</div> : "Loading…"}
      </main>
    )

  const question = !busy && canDesign && detail.status === "paused" ? pendingQuestion(detail) : null
  const isDashboard = detail.kind === "dashboard"
  const dashState = isDashboard ? (detail.state as DashboardAgentState) : null
  const build = dashState?.build && dashState.build.ok ? dashState.build : null
  const title = isDashboard
    ? dashState?.name || "New dashboard"
    : (detail.state as DesignerState)?.definition?.name || "New integration"
  return (
    <main className="session-page" ref={pageRef}>
      <div className="conversation">
        <div className="session-head">
          {/* Ids are plumbing: the title is the display name, or a placeholder
              until the agent names what it is building */}
          <h1>{title}</h1>
          {isDashboard && dashState?.saved && (
            <a href={`#/dashboard/${detail.integrationId}`}>Saved v{dashState.saved.version}</a>
          )}
          {detail.certified && <span className="chip chip-certified">cold-run certified</span>}
          {detail.scratchLayers.length > 0 && <a href={`#/map?session=${detail.id}`}>Map preview</a>}
          <span className="spacer" />
          <button className="details-toggle" onClick={() => setShowDetails(v => !v)}>
            {showDetails ? "Hide details" : "Show Details"}
          </button>
        </div>
        <div className="messages">
          <Transcript
            messages={frozenRef.current != null ? detail.messages.slice(0, frozenRef.current) : detail.messages}
            hideTrailingQuestion={question != null}
          />
          {toLiveGroups(live).map((group, i) => (
            <LiveBlock key={i} items={group} />
          ))}
          {busy && !live.some(i => i.kind === "tool" && i.open) && (
            <div className="thinking">
              <span className="spinner" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {question && <QuestionCard question={question} onAnswer={text => void send(text)} />}
        {previewErrors.length > 0 && (
          <div className="error">
            Preview error: {previewErrors[previewErrors.length - 1]} (attached to your next message)
          </div>
        )}
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
                : busy
                  ? "Steer the agent — your message lands after the current step…"
                  : "Describe what to build or change…"
            }
            disabled={!canDesign}
            rows={3}
          />
          {busy && input.trim() === "" ? (
            <button type="button" className="stop" onClick={() => void onStop()} disabled={!canDesign || stopping}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button type="submit" disabled={!canDesign || !input.trim()}>Send</button>
          )}
        </form>
      </div>
      {isDashboard && (
        <div
          className="split-handle"
          onPointerDown={onSplitDown}
          onDoubleClick={onSplitReset}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
        />
      )}
      {isDashboard && (
        <div className="preview-panel" style={{ flex: `0 0 ${(split * 100).toFixed(2)}%` }}>
          {build ? (
            <DashboardFrame
              key={build.rev}
              dashboardId={detail.integrationId ?? "draft"}
              bundleJs={build.bundleJs ?? ""}
              bundleCss={build.bundleCss ?? ""}
              // Drafts always build against the current kit; keep in step with KIT_VERSION
              kitVersion="3"
              runQuery={(name, params) => execSessionQuery(sessionId, name, params)}
              fetchVectorTile={(query, z, x, y, params) =>
                fetchTileBytes(`/api/sessions/${sessionId}`, query, z, x, y, params)
              }
              onError={message =>
                setPreviewErrors(errors => (errors.includes(message) ? errors : [...errors.slice(-4), message]))
              }
            />
          ) : (
            <div className="preview-empty">The dashboard preview appears here after the first successful build.</div>
          )}
        </div>
      )}
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
  /** Items collapsed into this row; non-tool rows always hold exactly one */
  items: LiveItem[]
}

/** Renders one in-flight row: user echo, assistant text, or a subtle activity line. */
function LiveBlock({ items }: LiveBlockProps) {
  const item = items[items.length - 1]
  if (item.kind === "user") return <div className="msg msg-user">{item.text}</div>
  if (item.kind === "assistant") return <Markdown className="msg msg-assistant" text={item.text ?? ""} />
  if (item.tool === "ask_user") return null // the question card is the rendering
  return (
    <div className="activity-block">
      <div className="activity">
        {activityLabel(item.tool, item.input, item.open)}
        {items.length > 1 && <span className="activity-count">×{items.length}</span>}
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

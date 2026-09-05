import { FormEvent, lazy, PointerEvent as ReactPointerEvent, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { activityLabel } from "./activity.js"
import {
  AssistantResult,
  AssistantState,
  DashboardAgentState,
  DashboardMeta,
  DesignerState,
  execSessionQuery,
  getSession,
  listLayers,
  listSources,
  sendMessage,
  SessionDetail,
  SessionEvent,
  stopSession,
  subscribeEvents
} from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { isBlockCall } from "./blocks/types.js"
import { DashboardFrame, fetchTileBytes } from "./DashboardFrame.js"
import { Markdown } from "./Markdown.js"
import { Transcript } from "./Transcript.js"
import { StatePanel } from "./StatePanel.js"
import { localizeData } from "./localization.js"

// Same lazy chunk as the stored transcript's blocks
const BlockRenderer = lazy(() => import("./blocks/BlockRenderer.js"))

/**
 * Draft preview meta: live catalog freshness, layers filtered to the draft's
 * declared list so the preview matches what viewers of the saved dashboard get.
 */
async function draftMeta(declared: string[]): Promise<DashboardMeta> {
  const [sources, layers] = await Promise.all([
    listSources().catch(() => ({ sources: [] })),
    listLayers().catch(() => ({ layers: [] }))
  ])
  const tables: Record<string, string | null> = {}
  for (const source of sources.sources) if (source.kind === "table") tables[source.id] = source.updatedAt
  return {
    tables,
    layers: layers.layers
      .filter(layer => declared.includes(layer.id))
      .map(layer => ({
        id: layer.id,
        name: layer.name,
        temporality: layer.temporality,
        currentSnapshotId: layer.current_snapshot_id ?? null,
        snapshots: (layer.snapshots ?? []).map(snapshot => ({
          id: snapshot.id,
          observedAt: snapshot.observed_at,
          observedEnd: snapshot.observed_end ?? null
        }))
      }))
  }
}

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

/** A completed call that renders as a result block rather than an activity row. */
function isLiveBlockItem(item: LiveItem): boolean {
  return item.kind === "tool" && !item.open && isBlockCall(item.tool, item.summary)
}

/**
 * Collapses adjacent live tool items that render the same label, matching the
 * stored transcript. A running call labels itself differently from a finished
 * one, so the in-flight item stays its own row until it completes and merges.
 * Result blocks never merge: each renders in full.
 */
function toLiveGroups(items: LiveItem[]): LiveItem[][] {
  const groups: LiveItem[][] = []
  for (const item of items) {
    const last = groups.at(-1)
    const mergeable =
      item.kind === "tool" &&
      !isLiveBlockItem(item) &&
      last?.[0].kind === "tool" &&
      !isLiveBlockItem(last[0]) &&
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
  // Full-screen preview hides the conversation so the dashboard can be judged
  // at its real size; Escape or the button brings the chat back
  const [previewFull, setPreviewFull] = useState(false)
  useEffect(() => {
    if (!previewFull) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewFull(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [previewFull])
  const pageRef = useRef<HTMLElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const kindRef = useRef<string | null>(null)
  // While the loop runs, the stored transcript is rendered only up to this
  // message count; the live event overlay covers everything newer. Mid-loop
  // refreshes persist steps into detail.messages, so without the cut the same
  // message renders twice (stored + live) until the loop ends.
  const frozenRef = useRef<number | null>(null)
  // Stored message count as currently rendered: the freeze point for a loop
  // first noticed through its SSE events (steering relaunch, another tab)
  const messagesLenRef = useRef(0)
  // Refetch sequence; late responses from superseded refetches are dropped
  const seqRef = useRef(0)
  // Full refetches carry the loop teardown (busy, freeze, overlay) that
  // mid-loop ones deliberately omit, so only a newer full refetch may
  // supersede one; a mid-loop refetch overtaking it would strand the view busy
  const fullSeqRef = useRef(0)
  // Pending trailing mid-loop refetch, cancelled once the loop ends
  const midLoopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((opts?: { midLoop?: boolean }) => {
    const seq = ++seqRef.current
    const fullSeq = opts?.midLoop ? 0 : ++fullSeqRef.current
    getSession(sessionId).then(d => {
      if (opts?.midLoop) {
        if (seq !== seqRef.current) return
        kindRef.current = d.kind
        // State-only: the live overlay owns everything newer than the freeze
        // point, so the rendered transcript must not advance mid-loop
        setDetail(prev => (prev ? { ...d, messages: prev.messages } : d))
        return
      }
      if (fullSeq !== fullSeqRef.current) return
      kindRef.current = d.kind
      messagesLenRef.current = d.messages.length
      frozenRef.current = d.running ? (frozenRef.current ?? d.messages.length) : null
      if (!d.running) setLive([])
      setDetail(d)
      setBusy(d.running)
    }, err => {
      if (opts?.midLoop ? seq === seqRef.current : fullSeq === fullSeqRef.current) setError(err.message)
    })
  }, [sessionId])

  // A design link (#/design?prompt=) lands here with the request in the hash
  // query: it goes into the composer, and the query is dropped from the
  // address so a reload does not write it in again
  useEffect(() => {
    const [base, query] = window.location.hash.split("?")
    const prompt = new URLSearchParams(query ?? "").get("prompt")
    if (!prompt) return
    setInput(prompt)
    window.history.replaceState(null, "", base)
  }, [sessionId])

  useEffect(() => {
    refresh()
    const unsubscribe = subscribeEvents(sessionId, event => onEvent(event))
    return () => {
      unsubscribe()
      if (midLoopTimer.current != null) clearTimeout(midLoopTimer.current)
    }
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
      // The loop is done; its trailing refetch would only race the full one
      if (midLoopTimer.current != null) {
        clearTimeout(midLoopTimer.current)
        midLoopTimer.current = null
      }
      setStopping(false)
      if (event.type === "error") setError(event.message ?? T`unknown error`)
      // Teardown (unfreeze, clear the overlay) waits for the refetch, so the
      // overlay keeps covering the tail until the stored transcript has it
      refresh()
      return
    }
    // Any live event means a loop is running, even one this tab did not start
    if (frozenRef.current == null) frozenRef.current = messagesLenRef.current
    setBusy(true)
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
        // Dashboard builds and assistant query results land in client state,
        // so refetch (state-only) to keep preview/blocks current mid-loop.
        // The trailing refetch covers the save landing just after the event;
        // the sequence guard discards whichever response is superseded.
        if (kindRef.current === "dashboard" || kindRef.current === "assistant") {
          refresh({ midLoop: true })
          if (midLoopTimer.current != null) clearTimeout(midLoopTimer.current)
          midLoopTimer.current = setTimeout(() => {
            midLoopTimer.current = null
            refresh({ midLoop: true })
          }, 700)
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
    if (!(await ensureAiAck())) return
    const wasBusy = busy
    if (!wasBusy) frozenRef.current = messagesLenRef.current
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
        {error ? <div className="error">{error}</div> : T`Loading…`}
      </main>
    )

  const isDashboard = detail.kind === "dashboard"
  const isAssistant = detail.kind === "assistant"
  // Viewers may chat with the read-only assistant; design kinds stay gated
  const canSend = isAssistant || canDesign
  const question = !busy && canSend && detail.status === "paused" ? pendingQuestion(detail) : null
  const dashState = isDashboard ? (detail.state as DashboardAgentState) : null
  const build = dashState?.build && dashState.build.ok ? dashState.build : null
  const assistantResults = isAssistant ? (detail.state as AssistantState)?.results : undefined
  const title = isAssistant
    ? detail.firstMessage || T`New question`
    : isDashboard
      ? dashState?.name || T`New dashboard`
      : (detail.state as DesignerState)?.definition?.name || T`New integration`
  // A finished designer session has installed its integration; the card is the
  // handoff to it, since the transcript alone leaves the user without a next step
  const installed =
    !busy && !isDashboard && !isAssistant && detail.status === "finished" && detail.integrationId != null
      ? (detail.state as DesignerState)
      : null
  return (
    <main className={`session-page${previewFull ? " preview-full" : ""}`} ref={pageRef}>
      <div className="conversation">
        <div className={`session-head${isDashboard ? " compact" : ""}`}>
          {/* Ids are plumbing: the title is the display name, or a placeholder
              until the agent names what it is building. Beside a preview it
              stays small; the dashboard carries its own heading */}
          <h1>{localizeData(title)}</h1>
          {isDashboard && dashState?.saved && (
            <a href={`#/dashboard/${detail.integrationId}`}>{T`Saved v${dashState.saved.version}`}</a>
          )}
          {/* Layers get their own pages, so this opens the first one; the
              details panel lists the rest */}
          {detail.scratchLayers.length > 0 && (
            <a href={`#/layer/${detail.scratchLayers[0].id}?session=${detail.id}`}>{T`Map preview`}</a>
          )}
          <span className="session-actions">
            {isDashboard && build && (
              <button
                className="icon-btn"
                onClick={() => setPreviewFull(true)}
                title={T`Full-screen preview (Esc to return)`}
                aria-label={T`Full-screen preview`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
              </button>
            )}
            <button className="icon-btn" onClick={() => setShowDetails(v => !v)} title={T`Session details`} aria-label={T`Session details`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <circle cx="12" cy="8" r="0.6" fill="currentColor" />
              </svg>
            </button>
          </span>
        </div>
        <div className="messages">
          <Transcript
            messages={frozenRef.current != null ? detail.messages.slice(0, frozenRef.current) : detail.messages}
            hideTrailingQuestion={question != null}
            results={assistantResults}
          />
          {toLiveGroups(live).map((group, i) => (
            <LiveBlock key={i} items={group} results={assistantResults} />
          ))}
          {busy && !live.some(i => i.kind === "tool" && i.open) && (
            <div className="thinking">
              <span className="spinner" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {question && <QuestionCard question={question} onAnswer={text => void send(text)} />}
        {installed && (
          <div className="question installed-card">
            <b>{T`Integration installed.`}</b>{" "}
            {installed.firstLoadStarted
              ? T`Its first data load started automatically — open it to see the data arrive.`
              : T`Open it to see its data, runs, and schedule.`}
            <div className="installed-actions">
              <a href={`#/integration/${detail.integrationId}`}>{T`Open Integration`}</a>
            </div>
          </div>
        )}
        {previewErrors.length > 0 && (
          <div className="error">
            {T`Preview error: ${previewErrors[previewErrors.length - 1]} (attached to your next message)`}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {!error && !busy && detail.error && (
          <div className="error">{T`The agent hit an error and stopped: ${detail.error} — send a message to retry.`}</div>
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
              !canSend
                ? T`Viewers can watch but not send`
                : busy
                  ? T`Steer the agent — your message lands after the current step…`
                  : isAssistant
                    ? T`Ask about the data…`
                    : T`Describe what to build or change…`
            }
            disabled={!canSend}
            rows={3}
          />
          {busy && input.trim() === "" ? (
            <button type="button" className="stop" onClick={() => void onStop()} disabled={!canSend || stopping}>
              {stopping ? T`Stopping…` : T`Stop`}
            </button>
          ) : (
            <button type="submit" disabled={!canSend || !input.trim()}>{T`Send`}</button>
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
          aria-label={T`Resize preview`}
        />
      )}
      {isDashboard && (
        <div className="preview-panel" style={previewFull ? { flex: "1 1 auto" } : { flex: `0 0 ${(split * 100).toFixed(2)}%` }}>
          {previewFull && (
            <button className="preview-exit" onClick={() => setPreviewFull(false)} title={T`Back to the conversation (Esc)`}>
              {T`Back to chat`}
            </button>
          )}
          {build ? (
            <DashboardFrame
              key={build.rev}
              dashboardId={detail.integrationId ?? "draft"}
              bundleJs={build.bundleJs ?? ""}
              bundleCss={build.bundleCss ?? ""}
              runQuery={(name, params) => execSessionQuery(sessionId, name, params)}
              fetchVectorTile={(query, z, x, y, params) =>
                fetchTileBytes(`/api/sessions/${sessionId}`, query, z, x, y, params)
              }
              fetchMeta={() => draftMeta(dashState?.layers ?? [])}
              fetchRasterTile={async (layerId, snapshotId, z, x, y) => {
                const res = await fetch(`/tiles/${layerId}/${snapshotId}/${z}/${x}/${y}.png`)
                if (!res.ok) throw new Error(`tile ${res.status}`)
                return res.arrayBuffer()
              }}
              onError={message =>
                setPreviewErrors(errors => (errors.includes(message) ? errors : [...errors.slice(-4), message]))
              }
            />
          ) : (
            <div className="preview-empty">{T`The dashboard preview appears here after the first successful build.`}</div>
          )}
        </div>
      )}
      {showDetails && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowDetails(false)} />
          <div className="details-drawer">
            <button className="drawer-close" onClick={() => setShowDetails(false)} aria-label={T`Close details`}>
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
  /** Stored assistant results, for rendering completed calls as result blocks */
  results?: Record<string, AssistantResult>
}

/** Renders one in-flight row: user echo, assistant text, a result block, or a subtle activity line. */
function LiveBlock({ items, results }: LiveBlockProps) {
  const item = items[items.length - 1]
  if (item.kind === "user") return <div className="msg msg-user">{item.text}</div>
  if (item.kind === "assistant") return <Markdown className="msg msg-assistant" text={item.text ?? ""} />
  if (item.tool === "ask_user") return null // the question card is the rendering
  if (!item.open && isBlockCall(item.tool, item.summary)) {
    // A completed assistant call renders as its block as soon as the mid-loop
    // state refetch delivers the stored result
    return (
      <Suspense fallback={<div className="activity">{T`Loading…`}</div>}>
        <BlockRenderer tool={item.tool ?? ""} input={item.input} resultText={item.summary} results={results} />
      </Suspense>
    )
  }
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
            <input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={T`Other…`} />
            <button type="submit" disabled={!text.trim()}>{T`Send`}</button>
          </form>
        ) : (
          <button className="question-other-toggle" onClick={() => setOther(true)}>{T`Other…`}</button>
        )}
      </div>
    </div>
  )
}

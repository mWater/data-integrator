import { Fragment, useState } from "react"
import { activityLabel } from "./activity.js"
import { MessagePart, TranscriptMessage } from "./api.js"
import { Markdown } from "./Markdown.js"

/** One rendered chat item derived from the stored transcript. */
interface ChatItem {
  /** Item kind; "question" is an ask_user call rendered as its question text */
  kind: "user" | "assistant" | "tool" | "question"
  /** Text for user/assistant/question items */
  text?: string
  /** Tool name for tool items */
  tool?: string
  /** Tool input JSON for tool items */
  input?: unknown
  /** Tool result text for tool items */
  result?: string
}

/** Extracts plain text from a message content value. */
function textOf(content: string | MessagePart[]): string {
  if (typeof content === "string") return content
  return content.filter(p => p.type === "text").map(p => p.text ?? "").join("")
}

/** Flattens stored model messages into renderable chat items. */
function toItems(messages: TranscriptMessage[]): ChatItem[] {
  const results = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") continue
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId) results.set(part.toolCallId, part.output?.value ?? "")
    }
  }

  const items: ChatItem[] = []
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ kind: "user", text: textOf(message.content) })
    } else if (message.role === "assistant") {
      const text = textOf(message.content)
      if (text) items.push({ kind: "assistant", text })
      if (typeof message.content !== "string") {
        for (const part of message.content) {
          if (part.type !== "tool-call") continue
          if (part.toolName === "ask_user") {
            // Questions read as conversation, not machinery
            const question = (part.input as { question?: unknown } | undefined)?.question
            if (question) items.push({ kind: "question", text: String(question) })
            continue
          }
          items.push({
            kind: "tool",
            tool: part.toolName,
            input: part.input,
            result: part.toolCallId ? results.get(part.toolCallId) : undefined
          })
        }
      }
    }
  }
  return items
}

/** A run of adjacent items rendered as one row. */
interface ChatGroup {
  /** Activity label for tool runs; absent for everything else */
  label?: string
  /** Members; only tool runs ever hold more than one */
  items: ChatItem[]
}

/**
 * Collapses adjacent tool calls that render the same label into one counted
 * row, so a burst of exploration reads as one line instead of a wall of
 * identical ones. Grouping on the label (not the tool name) keeps calls that
 * describe themselves differently, like cold vs warm test runs, apart.
 */
function toGroups(items: ChatItem[]): ChatGroup[] {
  const groups: ChatGroup[] = []
  for (const item of items) {
    if (item.kind !== "tool") {
      groups.push({ items: [item] })
      continue
    }
    const label = activityLabel(item.tool, item.input, false)
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** Props for the transcript. */
interface TranscriptProps {
  /** Stored model messages */
  messages: TranscriptMessage[]
  /** True while the pending-question card is shown, so the trailing question is not rendered twice */
  hideTrailingQuestion?: boolean
}

/** Renders the stored session transcript. */
export function Transcript({ messages, hideTrailingQuestion }: TranscriptProps) {
  const items = toItems(messages)
  const shown = hideTrailingQuestion && items.at(-1)?.kind === "question" ? items.slice(0, -1) : items
  return (
    <>
      {toGroups(shown).map((group, i) => {
        const item = group.items[0]
        return group.label != null ? (
          <ToolBlock key={i} label={group.label} items={group.items} />
        ) : item.kind === "assistant" || item.kind === "question" ? (
          <Markdown key={i} className="msg msg-assistant" text={item.text ?? ""} />
        ) : (
          <div key={i} className={`msg msg-${item.kind}`}>{item.text}</div>
        )
      })}
    </>
  )
}

/** Props for a completed tool block. */
interface ToolBlockProps {
  /** Shared activity label */
  label: string
  /** Calls collapsed into this row, in order */
  items: ChatItem[]
}

/** Completed tool calls: one subtle activity line, click for the raw detail. */
function ToolBlock({ label, items }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="activity-block">
      <div className="activity" onClick={() => setExpanded(v => !v)}>
        {label}
        {items.length > 1 && <span className="activity-count">×{items.length}</span>}
      </div>
      {expanded && (
        <div className="tool-detail">
          {items.map((item, i) => (
            <Fragment key={i}>
              <pre>{JSON.stringify(item.input, null, 2)}</pre>
              {item.result && <pre>{item.result}</pre>}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

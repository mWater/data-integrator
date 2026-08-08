import { useState } from "react"
import { MessagePart, TranscriptMessage } from "./api.js"

/** One rendered chat item derived from the stored transcript. */
interface ChatItem {
  /** Item kind */
  kind: "user" | "assistant" | "tool"
  /** Text for user/assistant items */
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
          if (part.type === "tool-call") {
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
  }
  return items
}

/** Props for the transcript. */
interface TranscriptProps {
  /** Stored model messages */
  messages: TranscriptMessage[]
}

/** Renders the stored session transcript. */
export function Transcript({ messages }: TranscriptProps) {
  return (
    <>
      {toItems(messages).map((item, i) =>
        item.kind === "tool" ? (
          <ToolBlock key={i} item={item} />
        ) : (
          <div key={i} className={`msg msg-${item.kind}`}>{item.text}</div>
        )
      )}
    </>
  )
}

/** Props for a completed tool block. */
interface ToolBlockProps {
  /** Tool item to render */
  item: ChatItem
}

/** A completed tool call: one-line summary, click to expand input and result. */
function ToolBlock({ item }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const firstLine = (item.result ?? "").split("\n")[0]
  return (
    <div className="tool" onClick={() => setExpanded(v => !v)}>
      <div className="tool-head">
        <span className="tool-name">{item.tool}</span>
        <span className="tool-summary">{firstLine}</span>
      </div>
      {expanded && (
        <div className="tool-detail">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre>{item.result}</pre>}
        </div>
      )}
    </div>
  )
}

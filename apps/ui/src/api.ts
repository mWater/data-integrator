/** Session summary row from GET /api/sessions. */
export interface SessionSummary {
  /** Session id */
  id: string
  /** Session status: active, paused, or finished */
  status: string
  /** Integration id of the draft */
  integrationId: string | null
  /** Model calls made so far */
  steps: number
  /** Last update time (ISO) */
  updatedAt: string
}

/** Draft definition fields the UI cares about (passed through as JSON). */
export interface Definition {
  /** Integration id */
  id: string
  /** Display name */
  name: string
  /** Runtime image id */
  runtime: string
  /** Single-file integration code */
  code: string
  /** Everything else in the definition */
  [key: string]: unknown
}

/** Designer client state mirrored from the server. */
export interface DesignerState {
  /** Draft definition */
  definition: Definition
  /** Cold-run certification, when one passed */
  coldRun: { definitionHash: string; runId: string } | null
  /** Most recent test run */
  lastRun: { runId: string; status: string; cold: boolean } | null
}

/** Full session detail from GET /api/sessions/:id. */
export interface SessionDetail extends SessionSummary {
  /** Serialized model messages (the transcript) */
  messages: TranscriptMessage[]
  /** Designer client state */
  state: DesignerState
  /** Cumulative usage counters */
  usage: { steps: number; inputTokens: number; outputTokens: number } | null
  /** True when the current definition passed a cold run */
  certified: boolean
  /** True while the loop is executing server-side */
  running: boolean
}

/** One content part of a stored model message. */
export interface MessagePart {
  /** Part discriminator: text, tool-call, tool-result, reasoning, ... */
  type: string
  /** Text content when type is "text" */
  text?: string
  /** Tool name for tool-call/tool-result parts */
  toolName?: string
  /** Correlates a tool-call with its tool-result */
  toolCallId?: string
  /** Tool input for tool-call parts */
  input?: unknown
  /** Tool output for tool-result parts */
  output?: { type: string; value: string }
}

/** One stored model message of the transcript. */
export interface TranscriptMessage {
  /** Message author: user, assistant, or tool */
  role: string
  /** Plain text or structured parts */
  content: string | MessagePart[]
}

/** One live event from the session SSE stream. */
export interface SessionEvent {
  /** Event discriminator */
  type: string
  /** Assistant or user text (assistant_text, user_message, stop) */
  text?: string
  /** Tool name (tool_start, tool_end) */
  tool?: string
  /** Tool input (tool_start) */
  input?: unknown
  /** Result prefix (tool_end) */
  summary?: string
  /** Job stderr line (job_log) */
  line?: string
  /** Stop reason (stop) */
  reason?: string
  /** Error message (error) */
  message?: string
}

/** Fetches JSON, throwing on HTTP errors with the server's message. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

/** Lists designer sessions. */
export function listSessions(): Promise<{ sessions: SessionSummary[] }> {
  return request("/api/sessions")
}

/** Creates a designer session for an integration id. */
export function createSession(integrationId: string): Promise<{ sessionId: string }> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationId })
  })
}

/** Fetches one session's detail. */
export function getSession(sessionId: string): Promise<SessionDetail> {
  return request(`/api/sessions/${sessionId}`)
}

/** Sends a user message into a session. */
export function sendMessage(sessionId: string, text: string): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  })
}

/** Subscribes to a session's SSE stream; returns the close function. */
export function subscribeEvents(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events`)
  source.onmessage = message => onEvent(JSON.parse(message.data))
  return () => source.close()
}

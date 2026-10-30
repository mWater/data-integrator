import { LanguageModel, ToolSet } from "ai"

/** Event emitted by the controller while a session step runs. */
export type AgentEvent =
  /** Assistant produced user-facing text */
  | { type: "assistant_text"; text: string }
  /** A tool call is starting */
  | { type: "tool_start"; tool: string; input: unknown }
  /** A tool call completed; summary is a short prefix of its result */
  | { type: "tool_end"; tool: string; summary: string }
  /** One stderr line streamed from a sandboxed job */
  | { type: "job_log"; line: string }
  /** An unbound draft took its integration id (first write_definition) */
  | { type: "integration_bound"; integrationId: string }

/** Listener for agent events. */
export type AgentEventListener = (event: AgentEvent) => void

/** Result of executing one server tool. */
export interface ToolOutcome<S> {
  /** Text returned to the model as the tool result */
  result: string
  /** Updated client state, when the tool changed it */
  state?: S
  /** True when this tool ends the session (finish) */
  finished?: boolean
  /** True to pause the session after this step for user input (e.g. thrash guard) */
  pause?: boolean
}

/**
 * One agent type (designer, assistant, dashboard): supplies the model, prompt,
 * tool schemas, and tool execution. The controller owns the loop and storage.
 */
export interface AgentImplementation<S> {
  /** Session kind stored in app.agent_sessions */
  kind: "designer" | "assistant" | "dashboard"
  /** Language model the loop calls */
  model: LanguageModel
  /** System prompt for the current client state */
  system(state: S): string
  /** Tool definitions; schemas only, execution goes through execute() */
  tools(state: S): ToolSet
  /** Executes one tool call against the current client state */
  execute(tool: string, input: unknown, state: S, events: AgentEventListener, sessionId: string): Promise<ToolOutcome<S>>
  /** Hard cap on model calls per session */
  maxSteps: number
  /** Cap on model calls per run (one user turn); the loop pauses when hit. Absent means no per-run cap */
  stepsPerRun?: number
}

/** Cumulative usage persisted with the session. */
export interface SessionUsage {
  /** Model calls made so far */
  steps: number
  /** Total input tokens */
  inputTokens: number
  /** Total output tokens */
  outputTokens: number
}

/** A file staged through a session's upload route, attached to the message that carries it. */
export interface SessionAttachment {
  /** File slot it was uploaded to */
  slot: string
  /** The uploaded version */
  versionId: string
}

/** A message the caller must fix (an attachment that is not this session's): 400, not 409. */
export class MessageRejectedError extends Error {}

/** A delete the session's state refuses (its integration exists, a run is in progress): 409. */
export class SessionDeleteRefusedError extends Error {}

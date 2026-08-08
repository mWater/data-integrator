import pg from "pg"
import { AgentSessionController } from "./controller.js"
import { DesignerDeps, DesignerImplementation, DesignerState, initialDesignerState } from "./designer.js"
import { ID_PATTERN, definitionHash } from "../install.js"

/** One event delivered to SSE subscribers; AgentEvents plus lifecycle. */
export type SessionEvent = Record<string, unknown> & { type: string }

/** Listener receiving session events. */
export type SessionListener = (event: SessionEvent) => void

/** Summary row for the session list. */
export interface SessionSummary {
  /** Session id */
  id: string
  /** Session status: active, paused, or finished */
  status: string
  /** Integration id of the draft; null until the agent names a new integration */
  integrationId: string | null
  /** First user message, as a label for sessions not yet named */
  firstMessage: string | null
  /** Model calls made so far */
  steps: number
  /** Last update time (ISO) */
  updatedAt: string
}

/** Full session detail for the session view. */
export interface SessionDetail extends SessionSummary {
  /** Serialized model messages (the transcript) */
  messages: unknown[]
  /** Designer client state (draft definition, runs, certification) */
  state: DesignerState
  /** Cumulative usage counters */
  usage: unknown
  /** True when the current definition hash passed a cold run */
  certified: boolean
  /** True while a loop is executing in this process */
  running: boolean
  /** Error that stopped the last loop, if it crashed (cleared on the next step) */
  error: string | null
  /** Scratch preview layers with data, for map links during design */
  scratchLayers: { id: string; name: string }[]
}

/** Per-session live bookkeeping. */
interface Channel {
  /** SSE subscribers */
  listeners: Set<SessionListener>
  /** True while a controller loop is executing */
  running: boolean
}

/**
 * Runs designer sessions inside the server process: creates sessions, executes
 * the loop on user messages, and fans events out to SSE subscribers. Sessions
 * themselves stay semi-stateless in Postgres; this holds only live plumbing.
 */
export class AgentService {
  private pool: pg.Pool
  private deps: DesignerDeps
  private controller: AgentSessionController<DesignerState>
  private channels = new Map<string, Channel>()
  private ready: Promise<void> | null = null

  /** Creates the service over designer deps (model included). */
  constructor(pool: pg.Pool, deps: DesignerDeps) {
    this.pool = pool
    this.deps = deps
    this.controller = new AgentSessionController(pool, new DesignerImplementation(deps))
  }

  /**
   * Creates a new designer session. Without an integration id the draft starts
   * unbound and the agent names it in its first write_definition. With one,
   * and when that integration is already installed, the session starts from
   * its installed definition so the agent edits rather than re-derives.
   */
  async createSession(integrationId?: string): Promise<string> {
    if (integrationId == null || integrationId === "") {
      return await this.controller.createSession(initialDesignerState())
    }
    if (!ID_PATTERN.test(integrationId)) throw new Error(`Invalid integration id: ${integrationId}`)
    const state = initialDesignerState(integrationId)
    const installed = await this.pool.query("SELECT definition FROM app.integrations WHERE id = $1", [integrationId])
    if (installed.rows.length > 0) state.definition = installed.rows[0].definition
    return await this.controller.createSession(state)
  }

  /** Lists designer sessions, newest first. */
  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.pool.query(
      `SELECT id, status, NULLIF(client_state->'definition'->>'id', '') AS integration_id,
              (SELECT left(msg->>'content', 120) FROM jsonb_array_elements(messages) msg
               WHERE msg->>'role' = 'user' LIMIT 1) AS first_message,
              COALESCE((usage->>'steps')::int, 0) AS steps, updated_at
       FROM app.agent_sessions WHERE kind = 'designer' ORDER BY updated_at DESC LIMIT 100`
    )
    return result.rows.map(r => ({
      id: r.id,
      status: r.status,
      integrationId: r.integration_id,
      firstMessage: r.first_message,
      steps: r.steps,
      updatedAt: r.updated_at.toISOString()
    }))
  }

  /** Full session detail, or null when the id is unknown. */
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const result = await this.pool.query(
      `SELECT id, status, messages, client_state, usage, error, updated_at
       FROM app.agent_sessions WHERE id = $1 AND kind = 'designer'`,
      [sessionId]
    )
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    const state = row.client_state as DesignerState
    const scratchLayers = await this.pool.query(
      "SELECT id, name FROM app.raster_layers WHERE session_id = $1 AND current_snapshot_id IS NOT NULL ORDER BY id",
      [sessionId]
    )
    const firstUser = (row.messages as { role: string; content: unknown }[]).find(m => m.role === "user")
    return {
      id: row.id,
      status: row.status,
      integrationId: state.definition?.id || null,
      firstMessage: typeof firstUser?.content === "string" ? firstUser.content.slice(0, 120) : null,
      steps: (row.usage?.steps as number) ?? 0,
      updatedAt: row.updated_at.toISOString(),
      messages: row.messages,
      state,
      usage: row.usage,
      certified: state.coldRun != null && state.coldRun.definitionHash === definitionHash(state.definition),
      running: this.channel(sessionId).running,
      error: row.error ?? null,
      scratchLayers: scratchLayers.rows
    }
  }

  /** Subscribes to a session's live events; returns the unsubscribe function. */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    const channel = this.channel(sessionId)
    channel.listeners.add(listener)
    return () => channel.listeners.delete(listener)
  }

  /** True while a loop is executing for this session in this process. */
  isRunning(sessionId: string): boolean {
    return this.channel(sessionId).running
  }

  /**
   * Appends a user message and starts the loop, broadcasting events. Resolves
   * once the loop is launched; completion is signaled by a `stop` (or `error`)
   * event. Throws immediately when the session is already running.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const channel = this.channel(sessionId)
    if (channel.running) throw new Error("Session is already running")
    channel.running = true
    await this.ensureRunner()

    const broadcast: SessionListener = event => {
      for (const listener of channel.listeners) listener(event)
    }
    broadcast({ type: "user_message", text })

    void this.controller
      .sendMessage(sessionId, text, event => broadcast(event as SessionEvent))
      .then(stop => broadcast({ type: "stop", reason: stop.reason, text: stop.text }))
      .catch(err => broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        channel.running = false
      })
  }

  /** Prepares the job runner once per process (network, keeper, egress). */
  private ensureRunner(): Promise<void> {
    this.ready ??= this.deps.runner.ensureReady()
    return this.ready
  }

  /** Channel for a session, created on first use. */
  private channel(sessionId: string): Channel {
    let channel = this.channels.get(sessionId)
    if (!channel) {
      channel = { listeners: new Set(), running: false }
      this.channels.set(sessionId, channel)
    }
    return channel
  }
}

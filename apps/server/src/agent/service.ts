import pg from "pg"
import { AgentSessionController } from "./controller.js"
import { AgentImplementation } from "./types.js"
import { DesignerDeps, DesignerImplementation, DesignerState, initialDesignerState } from "./designer.js"
import { DashboardAgentState, DashboardDeps, DashboardImplementation, initialDashboardState } from "./dashboard.js"
import { AssistantDeps, AssistantImplementation, AssistantState, initialAssistantState } from "./assistant.js"
import { ID_PATTERN, definitionHash } from "../install.js"

/** One event delivered to SSE subscribers; AgentEvents plus lifecycle. */
export type SessionEvent = Record<string, unknown> & { type: string }

/** Listener receiving session events. */
export type SessionListener = (event: SessionEvent) => void

/** Summary row for the session list. */
export interface SessionSummary {
  /** Session id */
  id: string
  /** Session kind: designer or dashboard */
  kind: string
  /** Session status: active, paused, or finished */
  status: string
  /** Bound artifact id (integration or dashboard); null until the agent names one */
  integrationId: string | null
  /** First user message, as a label for sessions not yet named */
  firstMessage: string | null
  /** Model calls made so far */
  steps: number
  /** Last update time (ISO) */
  updatedAt: string
  /** User who started the session; null for sessions created outside a sign-in (CLI) */
  userId: string | null
  /** True when the session holds work not yet saved anywhere others can see (dashboard drafts) */
  unsaved: boolean
  /** What the session is building, once named (a dashboard draft's name); null otherwise */
  label: string | null
  /** Email of the user who started the session; null when unknown */
  userEmail: string | null
}

/** Full session detail for the session view. */
export interface SessionDetail extends SessionSummary {
  /** Serialized model messages (the transcript) */
  messages: unknown[]
  /** Per-kind client state (designer draft, or dashboard draft) */
  state: unknown
  /** Cumulative usage counters */
  usage: unknown
  /** True when the current definition hash passed a cold run (designer only) */
  certified: boolean
  /** True while a loop is executing in this process */
  running: boolean
  /** Error that stopped the last loop, if it crashed (cleared on the next step) */
  error: string | null
  /** Scratch preview layers with data, for map links during design (designer only) */
  scratchLayers: { id: string; name: string }[]
}

/** Per-kind behavior the shared service delegates to. */
interface KindAdapter<S> {
  /** Session kind stored in agent_sessions.kind */
  kind: string
  /** Implementation driving the loop */
  implementation: AgentImplementation<S>
  /** SQL expression over agent_sessions yielding the bound artifact id */
  bindIdSql: string
  /** SQL over client_state answering "has unsaved work"; absent means never */
  unsavedSql?: string
  /** SQL over client_state naming what the session builds; absent means no label */
  labelSql?: string
  /** Initial client state; bindId is an integration or dashboard id to start from */
  initialState(bindId?: string, locale?: string): Promise<S>
  /** Bound artifact id from client state */
  bindId(state: S): string | null
  /** Kind-specific detail fields merged into SessionDetail */
  detailExtras(sessionId: string, state: S): Promise<Partial<SessionDetail>>
  /** One-time process preparation before the first loop */
  ensureReady(): Promise<void>
  /** Runs a requested credential's check snippet outside the loop; absent for kinds without credentials */
  checkSecret?(sessionId: string, state: S, name: string): Promise<{ ok: boolean; output: string }>
}

/** Per-session live bookkeeping. */
interface Channel {
  /** SSE subscribers */
  listeners: Set<SessionListener>
  /** True while a controller loop is executing */
  running: boolean
  /** Messages typed while running; injected at the next step boundary */
  steering: string[]
  /** True when the user asked the running loop to stop */
  stopRequested: boolean
}

/**
 * Runs agent sessions of one kind inside the server process: creates sessions,
 * executes the loop on user messages, and fans events out to SSE subscribers.
 * Sessions themselves stay semi-stateless in Postgres; this holds only live
 * plumbing. Construct via forDesigner() / forDashboard().
 */
export class AgentService<S = unknown> {
  private pool: pg.Pool
  private adapter: KindAdapter<S>
  private controller: AgentSessionController<S>
  private channels = new Map<string, Channel>()
  private ready: Promise<void> | null = null

  /** Creates the service over a kind adapter. */
  private constructor(pool: pg.Pool, adapter: KindAdapter<S>) {
    this.pool = pool
    this.adapter = adapter
    this.controller = new AgentSessionController(pool, adapter.implementation)
  }

  /** The designer service: sessions design integrations through the job runner. */
  static forDesigner(pool: pg.Pool, deps: DesignerDeps): AgentService<DesignerState> {
    const implementation = new DesignerImplementation(deps)
    return new AgentService<DesignerState>(pool, {
      kind: "designer",
      implementation,
      bindIdSql: "NULLIF(client_state->'definition'->>'id', '')",
      initialState: async (integrationId?: string) => {
        if (!integrationId) return initialDesignerState()
        if (!ID_PATTERN.test(integrationId)) throw new Error(`Invalid integration id: ${integrationId}`)
        const state = initialDesignerState(integrationId)
        const installed = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [integrationId])
        if (installed.rows.length > 0) state.definition = installed.rows[0].definition
        return state
      },
      bindId: state => state.definition?.id || null,
      detailExtras: async (sessionId, state) => {
        const scratchLayers = await pool.query(
          "SELECT id, name FROM app.raster_layers WHERE session_id = $1 AND current_snapshot_id IS NOT NULL ORDER BY id",
          [sessionId]
        )
        return {
          certified: state.coldRun != null && state.coldRun.definitionHash === definitionHash(state.definition),
          scratchLayers: scratchLayers.rows
        }
      },
      ensureReady: () => deps.runner.ensureReady(),
      checkSecret: (sessionId, state, name) => implementation.checkSecret(state, name, sessionId)
    })
  }

  /** The dashboard service: sessions design dashboards, no job runner involved. */
  static forDashboard(pool: pg.Pool, deps: DashboardDeps): AgentService<DashboardAgentState> {
    return new AgentService<DashboardAgentState>(pool, {
      kind: "dashboard",
      implementation: new DashboardImplementation(deps),
      bindIdSql: "NULLIF(client_state->>'dashboardId', '')",
      // Sessions from before saving was the user's have no dirty flag: a built,
      // never-saved draft is unsaved
      unsavedSql:
        "COALESCE((client_state->>'dirty')::boolean, client_state->'saved' = 'null'::jsonb AND client_state->'build' <> 'null'::jsonb)",
      labelSql: "NULLIF(client_state->>'name', '')",
      initialState: (dashboardId?: string, locale?: string) => initialDashboardState(pool, dashboardId ?? "", locale),
      bindId: state => state.dashboardId || null,
      detailExtras: async () => ({}),
      ensureReady: async () => {}
    })
  }

  /** The assistant service: read-only Q&A chat sessions, viewer-accessible. */
  static forAssistant(pool: pg.Pool, deps: AssistantDeps): AgentService<AssistantState> {
    return new AgentService<AssistantState>(pool, {
      kind: "assistant",
      implementation: new AssistantImplementation(deps),
      bindIdSql: "NULL::text",
      initialState: async () => initialAssistantState(),
      bindId: () => null,
      detailExtras: async () => ({}),
      ensureReady: async () => {}
    })
  }

  /** Session kind this service runs. */
  get kind(): string {
    return this.adapter.kind
  }

  /**
   * Creates a new session, optionally bound to an existing artifact id so the
   * agent edits rather than re-derives. userId records the creator.
   */
  async createSession(bindId?: string, userId?: string, locale?: string): Promise<string> {
    return await this.controller.createSession(await this.adapter.initialState(bindId, locale), userId, locale)
  }

  /** Lists this kind's sessions, newest first; forUserId narrows to one creator's. */
  async listSessions(forUserId?: string): Promise<SessionSummary[]> {
    const result = await this.pool.query(
      `SELECT id, status, user_id, ${this.adapter.bindIdSql} AS bind_id, ${this.adapter.unsavedSql ?? "false"} AS unsaved,
              ${this.adapter.labelSql ?? "NULL"} AS label,
              (SELECT email FROM app.users u WHERE u.id = user_id) AS user_email,
              (SELECT left(msg->>'content', 120) FROM jsonb_array_elements(messages) msg
               WHERE msg->>'role' = 'user' LIMIT 1) AS first_message,
              COALESCE((usage->>'steps')::int, 0) AS steps, updated_at
       FROM app.agent_sessions WHERE kind = $1 ${forUserId ? "AND user_id = $2" : ""}
       ORDER BY updated_at DESC LIMIT 100`,
      forUserId ? [this.adapter.kind, forUserId] : [this.adapter.kind]
    )
    return result.rows.map(r => ({
      id: r.id,
      kind: this.adapter.kind,
      status: r.status,
      integrationId: r.bind_id,
      firstMessage: r.first_message,
      steps: r.steps,
      updatedAt: r.updated_at.toISOString(),
      userId: r.user_id ?? null,
      unsaved: r.unsaved === true,
      label: r.label ?? null,
      userEmail: r.user_email ?? null
    }))
  }

  /** Full session detail, or null when the id is unknown. */
  /**
   * Runs a requested credential's check against its stored value, for the
   * session's credentials card. Refused while the agent loop is running (the
   * sandbox and scratch area are the loop's) and for kinds without credentials.
   */
  async checkSecret(sessionId: string, name: string): Promise<{ ok: boolean; output: string }> {
    if (!this.adapter.checkSecret) throw new Error("This session kind has no credentials")
    if (this.channel(sessionId).running) throw new Error("The session is busy; try again when it pauses")
    await this.ensureRunner()
    const state = await this.controller.getState(sessionId)
    return this.adapter.checkSecret(sessionId, state, name)
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const result = await this.pool.query(
      `SELECT id, status, user_id, messages, client_state, usage, error, updated_at,
              ${this.adapter.unsavedSql ?? "false"} AS unsaved, ${this.adapter.labelSql ?? "NULL"} AS label,
              (SELECT email FROM app.users u WHERE u.id = user_id) AS user_email
       FROM app.agent_sessions WHERE id = $1 AND kind = $2`,
      [sessionId, this.adapter.kind]
    )
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    const state = row.client_state as S
    const firstUser = (row.messages as { role: string; content: unknown }[]).find(m => m.role === "user")
    const extras = await this.adapter.detailExtras(sessionId, state)
    return {
      id: row.id,
      kind: this.adapter.kind,
      status: row.status,
      integrationId: this.adapter.bindId(state),
      firstMessage: typeof firstUser?.content === "string" ? firstUser.content.slice(0, 120) : null,
      steps: (row.usage?.steps as number) ?? 0,
      updatedAt: row.updated_at.toISOString(),
      userId: row.user_id ?? null,
      unsaved: row.unsaved === true,
      label: row.label ?? null,
      userEmail: row.user_email ?? null,
      messages: row.messages,
      state,
      usage: row.usage,
      certified: false,
      running: this.channel(sessionId).running,
      error: row.error ?? null,
      scratchLayers: [],
      ...extras
    }
  }

  /**
   * Deletes one session of this kind with its transcript and stored state.
   * forUserId restricts the delete to that creator's own sessions; a running
   * loop is asked to stop first, and its later saves fall on the deleted row.
   * Returns false when nothing matched.
   */
  async deleteSession(sessionId: string, forUserId?: string): Promise<boolean> {
    this.stop(sessionId)
    const result = await this.pool.query(
      `DELETE FROM app.agent_sessions WHERE id = $1 AND kind = $2${forUserId ? " AND user_id = $3" : ""}`,
      forUserId ? [sessionId, this.adapter.kind, forUserId] : [sessionId, this.adapter.kind]
    )
    if ((result.rowCount ?? 0) === 0) return false
    this.channels.delete(sessionId)
    return true
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
   * event. When the session is already running, the message queues as steering
   * and lands at the next step boundary.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const channel = this.channel(sessionId)
    const broadcast: SessionListener = event => {
      for (const listener of channel.listeners) listener(event)
    }
    if (channel.running) {
      channel.steering.push(text)
      broadcast({ type: "user_message", text })
      return
    }
    channel.running = true
    channel.stopRequested = false
    try {
      await this.ensureRunner()
      // Persist the message before launching the loop, so a page navigating
      // here right after this call finds it in the stored transcript instead
      // of waiting out the first (slow) model step
      await this.controller.appendUserMessage(sessionId, text)
    } catch (err) {
      channel.running = false
      throw err
    }
    broadcast({ type: "user_message", text })

    void this.controller
      .resume(sessionId, event => broadcast(event as SessionEvent), {
        drainSteering: () => channel.steering.splice(0),
        stopRequested: () => channel.stopRequested
      })
      .then(stop => {
        broadcast({ type: "stop", reason: stop.reason, text: stop.text })
        channel.running = false
        // Steering that missed the loop starts a fresh one, unless the user stopped
        if (channel.steering.length > 0) {
          const leftover = channel.steering.splice(0)
          if (stop.reason !== "stopped") {
            void this.startQueued(sessionId, leftover.join("\n\n"))
          }
        }
      })
      .catch(err => {
        channel.running = false
        channel.steering.length = 0
        broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
      })
  }

  /**
   * Requests a graceful stop of the running loop; it pauses at the next step
   * boundary (an in-flight model call or sandbox job finishes first). Returns
   * false when nothing is running.
   */
  stop(sessionId: string): boolean {
    const channel = this.channel(sessionId)
    if (!channel.running) return false
    channel.stopRequested = true
    return true
  }

  /** Relaunches the loop for steering that arrived after the previous loop ended. */
  private async startQueued(sessionId: string, text: string): Promise<void> {
    const channel = this.channel(sessionId)
    if (channel.running) {
      channel.steering.push(text)
      return
    }
    // The user message event was already broadcast when the text was queued
    channel.running = true
    channel.stopRequested = false
    const broadcast: SessionListener = event => {
      for (const listener of channel.listeners) listener(event)
    }
    try {
      await this.controller.appendUserMessage(sessionId, text)
    } catch (err) {
      channel.running = false
      broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
      return
    }
    void this.controller
      .resume(sessionId, event => broadcast(event as SessionEvent), {
        drainSteering: () => channel.steering.splice(0),
        stopRequested: () => channel.stopRequested
      })
      .then(stop => broadcast({ type: "stop", reason: stop.reason, text: stop.text }))
      .catch(err => broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        channel.running = false
      })
  }

  /** One-time per-process preparation (e.g. the designer's job runner). */
  private ensureRunner(): Promise<void> {
    this.ready ??= this.adapter.ensureReady()
    return this.ready
  }

  /** Channel for a session, created on first use. */
  private channel(sessionId: string): Channel {
    let channel = this.channels.get(sessionId)
    if (!channel) {
      channel = { listeners: new Set(), running: false, steering: [], stopRequested: false }
      this.channels.set(sessionId, channel)
    }
    return channel
  }
}

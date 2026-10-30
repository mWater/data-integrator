import { generateText, ModelMessage, ToolResultPart } from "ai"
import pg from "pg"
import { AgentEventListener, AgentImplementation, SessionUsage, ToolOutcome } from "./types.js"

/** Cap on a single tool result returned to the model. */
const TOOL_RESULT_MAX = 16_000

/**
 * Output cap per model call (reasoning included). Steps emit tool calls and
 * short prose, so this is ample; it also bounds per-step spend, which
 * providers pre-authorize against remaining credit at the full cap.
 */
const OUTPUT_TOKENS_MAX = 16_000

/** Why a session run stopped. */
export type StopReason = "finished" | "awaiting_user" | "step_limit" | "stopped"

/** Host hooks that influence a running loop between steps. */
export interface LoopControls {
  /** Returns and clears user messages queued while the loop runs (steering) */
  drainSteering?: () => string[]
  /** True when the user asked to stop; the loop pauses at the next boundary */
  stopRequested?: () => boolean
}

/** Outcome of running a session until it stops. */
export interface SessionStop {
  /** The session that ran */
  sessionId: string
  /** Why it stopped */
  reason: StopReason
  /** Final assistant text when the model stopped with a message */
  text: string | null
}

/** Spending guard around model calls: checked before each call, fed after it. */
export interface TokenBudget {
  /** Throws, with a message for the user, when the session's owner may not call the model now */
  check(userId: string | null): Promise<void>
  /** Records one call's input plus output tokens against the owner */
  record(userId: string | null, tokens: number): Promise<void>
}

/** In-memory view of one session row. */
interface SessionData<S> {
  /** Owning user; null for CLI sessions */
  userId: string | null
  status: string
  messages: ModelMessage[]
  state: S
  usage: SessionUsage
}

/**
 * Generic agent session loop over app.agent_sessions. One step = one model
 * call plus execution of its tool calls; the whole session is serialized to
 * Postgres after every step, so any process can resume any session.
 */
export class AgentSessionController<S> {
  private pool: pg.Pool
  private impl: AgentImplementation<S>
  private budget: TokenBudget | null

  /** Creates a controller for one agent implementation, optionally under a token budget. */
  constructor(pool: pg.Pool, impl: AgentImplementation<S>, budget?: TokenBudget) {
    this.pool = pool
    this.impl = impl
    this.budget = budget ?? null
  }

  /** Creates a new paused session with the given initial client state. */
  async createSession(state: S, userId?: string, locale?: string): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO app.agent_sessions (kind, user_id, status, messages, client_state, usage, locale)
       VALUES ($1, $2, 'paused', '[]', $3, $4, $5) RETURNING id`,
      [this.impl.kind, userId ?? null, JSON.stringify(state), JSON.stringify(emptyUsage()), locale ?? null]
    )
    return result.rows[0].id
  }

  /**
   * Appends a user message and persists the session as active, so the
   * transcript shows the message before the first (slow) model step lands.
   * Any status accepts messages: "finished" marks the agent's task complete
   * but is never terminal — the session continues like a paused one.
   */
  async appendUserMessage(sessionId: string, text: string): Promise<void> {
    const session = await this.load(sessionId)
    session.messages.push({ role: "user", content: text })
    await this.save(sessionId, "active", session)
  }

  /** Appends a user message and runs the loop until the session stops. */
  async sendMessage(
    sessionId: string,
    text: string,
    events?: AgentEventListener,
    controls?: LoopControls
  ): Promise<SessionStop> {
    await this.appendUserMessage(sessionId, text)
    const session = await this.load(sessionId)
    return await this.runLoop(sessionId, session, events, controls)
  }

  /** Resumes an active session (e.g. after a crash) without a new user message. */
  async resume(sessionId: string, events?: AgentEventListener, controls?: LoopControls): Promise<SessionStop> {
    const session = await this.load(sessionId)
    if (session.status !== "active") throw new Error(`Session ${sessionId} is ${session.status}, not active`)
    return await this.runLoop(sessionId, session, events, controls)
  }

  /** Current client state of a session. */
  async getState(sessionId: string): Promise<S> {
    return (await this.load(sessionId)).state
  }

  /** Replaces a session's client state; only safe while no loop runs it, since the loop saves its own copy. */
  async setState(sessionId: string, state: S): Promise<void> {
    await this.pool.query("UPDATE app.agent_sessions SET client_state = $2, updated_at = now() WHERE id = $1 AND kind = $3", [
      sessionId,
      JSON.stringify(state),
      this.impl.kind
    ])
  }

  /**
   * Steps until the model stops, a tool finishes or pauses the session, or the
   * cap hits. A loop crash (model/provider failure) persists the session as
   * paused with the error recorded, so it stays resumable from the UI.
   */
  private async runLoop(
    sessionId: string,
    session: SessionData<S>,
    events?: AgentEventListener,
    controls?: LoopControls
  ): Promise<SessionStop> {
    try {
      return await this.runSteps(sessionId, session, events, controls)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.save(sessionId, "paused", session, message).catch(() => {})
      throw err
    }
  }

  /** The step loop proper; any throw is handled by runLoop. */
  private async runSteps(
    sessionId: string,
    session: SessionData<S>,
    events?: AgentEventListener,
    controls?: LoopControls
  ): Promise<SessionStop> {
    const emit: AgentEventListener = events ?? (() => {})
    let stepsThisRun = 0
    for (;;) {
      // Steering typed while the loop ran lands here, before the next model call
      for (const text of controls?.drainSteering?.() ?? []) {
        session.messages.push({ role: "user", content: text })
      }
      if (controls?.stopRequested?.()) {
        await this.save(sessionId, "paused", session)
        return { sessionId, reason: "stopped", text: null }
      }
      if (session.usage.steps >= this.impl.maxSteps || stepsThisRun >= (this.impl.stepsPerRun ?? Infinity)) {
        await this.save(sessionId, "paused", session)
        return { sessionId, reason: "step_limit", text: null }
      }

      await this.budget?.check(session.userId)
      const result = await generateText({
        model: this.impl.model,
        system: this.impl.system(session.state),
        messages: session.messages,
        tools: this.impl.tools(session.state),
        maxOutputTokens: OUTPUT_TOKENS_MAX
      })
      session.usage.steps++
      stepsThisRun++
      session.usage.inputTokens += result.usage.inputTokens ?? 0
      session.usage.outputTokens += result.usage.outputTokens ?? 0
      await this.budget?.record(session.userId, (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0))
      session.messages.push(...(result.response.messages as ModelMessage[]))
      if (result.text) emit({ type: "assistant_text", text: result.text })

      if (result.toolCalls.length === 0) {
        await this.save(sessionId, "paused", session)
        return { sessionId, reason: "awaiting_user", text: result.text || null }
      }

      // Stop before executing tools: cancel them with synthetic results so the
      // transcript stays a valid sequence and stop beats long-running work
      if (controls?.stopRequested?.()) {
        session.messages.push({
          role: "tool",
          content: result.toolCalls.map(call => ({
            type: "tool-result" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text" as const, value: "Cancelled: the user stopped the session before this ran." }
          }))
        })
        await this.save(sessionId, "paused", session)
        return { sessionId, reason: "stopped", text: null }
      }

      const content: ToolResultPart[] = []
      let finished = false
      let paused = false
      for (const call of result.toolCalls) {
        emit({ type: "tool_start", tool: call.toolName, input: call.input })
        let outcome: ToolOutcome<S>
        try {
          outcome = await this.impl.execute(call.toolName, call.input, session.state, emit, sessionId)
        } catch (err) {
          outcome = { result: `Tool error: ${err instanceof Error ? err.message : String(err)}` }
        }
        if (outcome.state !== undefined) session.state = outcome.state
        if (outcome.finished) finished = true
        if (outcome.pause) paused = true
        const value = truncate(outcome.result)
        emit({ type: "tool_end", tool: call.toolName, summary: value.slice(0, 200) })
        content.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value }
        })
      }
      session.messages.push({ role: "tool", content })

      await this.save(sessionId, finished ? "finished" : paused ? "paused" : "active", session)
      if (finished) return { sessionId, reason: "finished", text: null }
      if (paused) return { sessionId, reason: "awaiting_user", text: null }
    }
  }

  /** Loads one session row. */
  private async load(sessionId: string): Promise<SessionData<S>> {
    const result = await this.pool.query(
      "SELECT user_id, status, messages, client_state, usage FROM app.agent_sessions WHERE id = $1 AND kind = $2",
      [sessionId, this.impl.kind]
    )
    if (result.rows.length === 0) throw new Error(`No ${this.impl.kind} session ${sessionId}`)
    const row = result.rows[0]
    return {
      userId: row.user_id ?? null,
      status: row.status,
      messages: row.messages as ModelMessage[],
      state: row.client_state as S,
      usage: (row.usage as SessionUsage) ?? emptyUsage()
    }
  }

  /** Serializes the session back to its row; error is cleared unless given. */
  private async save(sessionId: string, status: string, session: SessionData<S>, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE app.agent_sessions
       SET status = $2, messages = $3, client_state = $4, usage = $5, error = $6, updated_at = now()
       WHERE id = $1`,
      [
        sessionId,
        status,
        JSON.stringify(session.messages),
        JSON.stringify(session.state),
        JSON.stringify(session.usage),
        error ?? null
      ]
    )
  }
}

/** Zeroed usage counters. */
function emptyUsage(): SessionUsage {
  return { steps: 0, inputTokens: 0, outputTokens: 0 }
}

/** Truncates a tool result to the per-result cap, marking the cut. */
function truncate(text: string): string {
  if (text.length <= TOOL_RESULT_MAX) return text
  return text.slice(0, TOOL_RESULT_MAX) + `\n[truncated, ${text.length} chars total]`
}

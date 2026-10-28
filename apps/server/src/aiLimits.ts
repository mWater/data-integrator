/**
 * Daily AI token caps, per user and per deployment. Counted in input plus
 * output tokens, so they hold for every provider (not all report cost). The
 * agent loop checks the caps before each model call and records the call's
 * tokens after it, so one call in flight can overrun a cap by its own size.
 * Days are UTC.
 */

import pg from "pg"
import { TokenBudget } from "./agent/controller.js"
import { getSetting, setSetting } from "./settings.js"

/** Settings key holding the caps. */
export const AI_LIMITS_KEY = "ai_limits"

/** Daily token caps; null means no cap. */
export interface AiLimits {
  /** Tokens one user's sessions may use per UTC day */
  userDailyTokens: number | null
  /** Tokens all sessions together may use per UTC day */
  deploymentDailyTokens: number | null
}

/** Caps in force until an admin saves others. */
export const DEFAULT_AI_LIMITS: AiLimits = { userDailyTokens: 5_000_000, deploymentDailyTokens: 25_000_000 }

/** Tokens used so far today. */
export interface AiUsageToday {
  /** By the given user (CLI sessions count as one user) */
  user: number
  /** By everyone */
  deployment: number
}

/** The caps in force. */
export async function getAiLimits(pool: pg.Pool): Promise<AiLimits> {
  return (await getSetting<AiLimits>(pool, AI_LIMITS_KEY)) ?? DEFAULT_AI_LIMITS
}

/** Saves the caps. */
export async function saveAiLimits(pool: pg.Pool, limits: AiLimits): Promise<void> {
  await setSetting(pool, AI_LIMITS_KEY, limits)
}

/** Validates an admin's save request: each cap is a positive integer or null. */
export function parseAiLimits(body: unknown): AiLimits {
  if (typeof body !== "object" || body === null) throw new Error("Expected a JSON object")
  const b = body as Record<string, unknown>
  const cap = (name: keyof AiLimits): number | null => {
    const value = b[name]
    if (value === null || value === undefined) return null
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive whole number of tokens, or null for no cap`)
    }
    return value
  }
  return { userDailyTokens: cap("userDailyTokens"), deploymentDailyTokens: cap("deploymentDailyTokens") }
}

/** Tokens used today by one user and by the deployment. */
export async function aiUsageToday(pool: pg.Pool, userId: string | null): Promise<AiUsageToday> {
  const result = await pool.query(
    `SELECT coalesce(sum(tokens) FILTER (WHERE user_id IS NOT DISTINCT FROM $1), 0)::bigint AS user,
            coalesce(sum(tokens), 0)::bigint AS deployment
     FROM app.ai_usage WHERE day = (now() AT TIME ZONE 'UTC')::date`,
    [userId]
  )
  return { user: Number(result.rows[0].user), deployment: Number(result.rows[0].deployment) }
}

/** Adds one model call's tokens to today's count for the user. */
export async function recordAiUsage(pool: pg.Pool, userId: string | null, tokens: number): Promise<void> {
  if (tokens <= 0) return
  await pool.query(
    `INSERT INTO app.ai_usage (day, user_id, tokens) VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2)
     ON CONFLICT (day, user_id) DO UPDATE SET tokens = app.ai_usage.tokens + EXCLUDED.tokens`,
    [userId, tokens]
  )
}

/**
 * Throws when today's usage has reached a cap, naming which one. Called
 * before every model call of every agent session.
 */
export async function checkAiBudget(pool: pg.Pool, userId: string | null): Promise<void> {
  const limits = await getAiLimits(pool)
  if (limits.userDailyTokens === null && limits.deploymentDailyTokens === null) return
  const used = await aiUsageToday(pool, userId)
  if (limits.deploymentDailyTokens !== null && used.deployment >= limits.deploymentDailyTokens) {
    throw new Error("This deployment has used its daily AI allowance. AI features resume at midnight UTC, or an admin can raise the limit in Settings.")
  }
  if (limits.userDailyTokens !== null && used.user >= limits.userDailyTokens) {
    throw new Error("You have used your daily AI allowance. AI features resume for you at midnight UTC, or an admin can raise the limit in Settings.")
  }
}

/** The caps as the agent loop's token budget. */
export function aiTokenBudget(pool: pg.Pool): TokenBudget {
  return {
    check: userId => checkAiBudget(pool, userId),
    record: (userId, tokens) => recordAiUsage(pool, userId, tokens)
  }
}

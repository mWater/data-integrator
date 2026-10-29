/**
 * Optional account policy for deployments whose security standard calls for
 * it: password expiry and disabling of inactive accounts. Both are off by
 * default; NIST SP 800-63B advises against forced periodic password changes,
 * so expiry exists for deployers whose own policy requires it.
 *
 * Expiry is enforced at sign-in (auth.ts): the user must choose a new password
 * to get a session. Inactivity is enforced by the daily housekeeping sweep.
 */

import pg from "pg"
import { getSetting, setSetting } from "./settings.js"
import { logSecurityEvent } from "./securityLog.js"

/** Settings key holding the policy. */
export const ACCOUNT_POLICY_KEY = "account_policy"

/** Account policy; null turns a rule off. */
export interface AccountPolicy {
  /** Days after which a password must be changed at next sign-in */
  passwordMaxAgeDays: number | null
  /** Days without sign-in or API use after which an account is disabled */
  inactiveDisableDays: number | null
}

/** Policy in force until an admin saves another: both rules off. */
export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = { passwordMaxAgeDays: null, inactiveDisableDays: null }

/** The policy in force. */
export async function getAccountPolicy(pool: pg.Pool): Promise<AccountPolicy> {
  return (await getSetting<AccountPolicy>(pool, ACCOUNT_POLICY_KEY)) ?? DEFAULT_ACCOUNT_POLICY
}

/** Saves the policy. */
export async function saveAccountPolicy(pool: pg.Pool, policy: AccountPolicy): Promise<void> {
  await setSetting(pool, ACCOUNT_POLICY_KEY, policy)
}

/** Validates an admin's save request: each rule is a whole number of days (1 to 3650) or null. */
export function parseAccountPolicy(body: unknown): AccountPolicy {
  if (typeof body !== "object" || body === null) throw new Error("Expected a JSON object")
  const b = body as Record<string, unknown>
  const days = (name: keyof AccountPolicy): number | null => {
    const value = b[name]
    if (value === null || value === undefined) return null
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3650) {
      throw new Error(`${name} must be a whole number of days from 1 to 3650, or null to turn it off`)
    }
    return value
  }
  return { passwordMaxAgeDays: days("passwordMaxAgeDays"), inactiveDisableDays: days("inactiveDisableDays") }
}

/**
 * Disables accounts inactive past the policy's limit and revokes their
 * sessions; returns how many were disabled (0 when the rule is off). An admin
 * is disabled only while another admin remains enabled and active, so the
 * sweep never locks every administrator out.
 */
export async function disableInactiveAccounts(pool: pg.Pool): Promise<number> {
  const { inactiveDisableDays } = await getAccountPolicy(pool)
  if (inactiveDisableDays === null) return 0
  const result = await pool.query(
    `WITH disabled AS (
       UPDATE app.users u SET disabled = true, updated_at = now()
       WHERE NOT u.disabled AND u.last_active_at < now() - make_interval(days => $1)
         AND (u.role <> 'admin' OR EXISTS (
           SELECT 1 FROM app.users a
           WHERE a.role = 'admin' AND NOT a.disabled AND a.last_active_at >= now() - make_interval(days => $1)))
       RETURNING u.id, u.email, u.role
     ), revoked AS (
       DELETE FROM app.auth_sessions s USING disabled d WHERE s.user_id = d.id
     )
     SELECT id, email, role FROM disabled`,
    [inactiveDisableDays]
  )
  for (const row of result.rows) {
    logSecurityEvent("account.disabled_inactive", { userId: row.id, email: row.email, role: row.role, inactiveDisableDays })
  }
  return result.rows.length
}

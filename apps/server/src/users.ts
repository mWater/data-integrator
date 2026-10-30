import { randomBytes } from "node:crypto"
import pg from "pg"
import { AuthUser, hashPassword } from "./auth.js"

/** One user as the admin management UI sees it. */
export interface ManagedUser {
  /** User id */
  id: string
  /** Login email */
  email: string
  /** Role: admin, editor, or viewer */
  role: AuthUser["role"]
  /** Whether sign-in is blocked */
  disabled: boolean
  /** Creation time (ISO) */
  createdAt: string
}

/** Outcome of a guarded user mutation. */
export type UserUpdateResult =
  | { ok: true; user: ManagedUser }
  | { ok: false; reason: "not-found" | "last-admin" }

/** Random initial password (16 URL-safe chars), matching the CLI. */
export function generatePassword(): string {
  return randomBytes(12).toString("base64url")
}

/** Maps a users row to its API shape. */
function toManagedUser(row: {
  id: string
  email: string
  role: AuthUser["role"]
  disabled: boolean
  created_at: Date
}): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at.toISOString()
  }
}

/**
 * Creates a user with a generated password and returns both; the password is
 * shown once and never stored in the clear. Throws on duplicate email.
 */
export async function createManagedUser(
  pool: pg.Pool,
  email: string,
  role: AuthUser["role"]
): Promise<{ user: ManagedUser; password: string }> {
  const password = generatePassword()
  const result = await pool.query(
    `INSERT INTO app.users (email, password_hash, role) VALUES ($1, $2, $3)
     RETURNING id, email, role, disabled, created_at`,
    [email, await hashPassword(password), role]
  )
  return { user: toManagedUser(result.rows[0]), password }
}

/** All users, oldest first. */
export async function listUsers(pool: pg.Pool): Promise<ManagedUser[]> {
  const result = await pool.query(
    "SELECT id, email, role, disabled, created_at FROM app.users ORDER BY lower(email)"
  )
  return result.rows.map(toManagedUser)
}

/**
 * Applies a role or disabled change unless it would leave the deployment with
 * no active admin. Locks the active-admin rows so concurrent demotions cannot
 * each see the other admin as still standing.
 */
async function guardedUpdate(
  pool: pg.Pool,
  id: string,
  wouldRemoveAdmin: (target: { role: AuthUser["role"]; disabled: boolean }) => boolean,
  update: (client: pg.PoolClient) => Promise<pg.QueryResult>
): Promise<UserUpdateResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const admins = await client.query("SELECT id FROM app.users WHERE role = 'admin' AND NOT disabled FOR UPDATE")
    const target = await client.query("SELECT id, role, disabled FROM app.users WHERE id = $1", [id])
    if (target.rows.length === 0) {
      await client.query("ROLLBACK")
      return { ok: false, reason: "not-found" }
    }
    const row = target.rows[0]
    const isActiveAdmin = row.role === "admin" && !row.disabled
    if (isActiveAdmin && wouldRemoveAdmin(row) && !admins.rows.some(a => a.id !== id)) {
      await client.query("ROLLBACK")
      return { ok: false, reason: "last-admin" }
    }
    const updated = await update(client)
    await client.query("COMMIT")
    return { ok: true, user: toManagedUser(updated.rows[0]) }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Changes a user's role; refuses to demote the last active admin. */
export async function setRole(pool: pg.Pool, id: string, role: AuthUser["role"]): Promise<UserUpdateResult> {
  return guardedUpdate(
    pool,
    id,
    () => role !== "admin",
    client =>
      client.query(
        `UPDATE app.users SET role = $2, updated_at = now()
         WHERE id = $1 RETURNING id, email, role, disabled, created_at`,
        [id, role]
      )
  )
}

/**
 * Disables or enables a user; refuses to disable the last active admin.
 * Disabling also revokes the user's sessions so re-enabling requires a fresh
 * sign-in. Enabling restarts the inactivity clock, so the account policy's
 * sweep does not disable it again before the user can sign in.
 */
export async function setDisabled(pool: pg.Pool, id: string, disabled: boolean): Promise<UserUpdateResult> {
  return guardedUpdate(
    pool,
    id,
    () => disabled,
    async client => {
      if (disabled) await client.query("DELETE FROM app.auth_sessions WHERE user_id = $1", [id])
      return client.query(
        `UPDATE app.users SET disabled = $2, updated_at = now(),
           last_active_at = CASE WHEN $2 THEN last_active_at ELSE now() END
         WHERE id = $1 RETURNING id, email, role, disabled, created_at`,
        [id, disabled]
      )
    }
  )
}

/**
 * Sets a fresh generated password (clearing any lockout) and returns it, or
 * null if no such user.
 */
export async function resetPassword(pool: pg.Pool, id: string): Promise<string | null> {
  const password = generatePassword()
  const result = await pool.query(
    `UPDATE app.users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
       updated_at = now()
     WHERE id = $1`,
    [id, await hashPassword(password)]
  )
  return (result.rowCount ?? 0) > 0 ? password : null
}

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import pg from "pg"

const scryptP = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>

/** scrypt parameters (OWASP-recommended cost, ~100 ms per hash). */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 }

/** Failed logins before a lockout. */
const LOCKOUT_THRESHOLD = 10

/** Lockout duration in minutes. */
const LOCKOUT_MINUTES = 15

/** Session lifetime in days. */
const SESSION_DAYS = 30

/** An authenticated user as the HTTP layer sees it. */
export interface AuthUser {
  /** User id */
  id: string
  /** Login email */
  email: string
  /** Role: admin, editor, or viewer */
  role: "admin" | "editor" | "viewer"
}

/** Outcome of a login attempt. */
export type AuthResult = { ok: true; user: AuthUser } | { ok: false; reason: "bad-credentials" | "locked" | "disabled" }

/** Hashes a password; output encodes its own parameters. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptP(password, salt, SCRYPT.keylen, SCRYPT)
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64")}:${hash.toString("base64")}`
}

/** Verifies a password against a stored hash (parameters read from the hash). */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, N, r, p, saltB64, hashB64] = stored.split(":")
  if (scheme !== "scrypt") return false
  const expected = Buffer.from(hashB64, "base64")
  const actual = await scryptP(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem
  })
  return timingSafeEqual(actual, expected)
}

/** Creates a user; throws on duplicate email. */
export async function createUser(pool: pg.Pool, email: string, password: string, role: AuthUser["role"]): Promise<AuthUser> {
  const result = await pool.query(
    "INSERT INTO app.users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
    [email, await hashPassword(password), role]
  )
  return result.rows[0]
}

/** Replaces a user's password and clears any lockout. */
export async function setPassword(pool: pg.Pool, email: string, password: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now()
     WHERE email = $1`,
    [email, await hashPassword(password)]
  )
  return (result.rowCount ?? 0) > 0
}

/** Dummy hash verified for unknown emails so both paths cost the same time. */
const TIMING_DECOY = hashPassword("decoy")

/**
 * Checks credentials with lockout accounting: failures increment a counter,
 * LOCKOUT_THRESHOLD of them lock the account for LOCKOUT_MINUTES.
 */
export async function authenticate(pool: pg.Pool, email: string, password: string): Promise<AuthResult> {
  const result = await pool.query(
    `SELECT id, email, role, password_hash, disabled, failed_logins, locked_until
     FROM app.users WHERE email = $1`,
    [email]
  )
  if (result.rows.length === 0) {
    await verifyPassword(await TIMING_DECOY, password)
    return { ok: false, reason: "bad-credentials" }
  }
  const row = result.rows[0]
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, reason: "locked" }

  if (!(await verifyPassword(row.password_hash, password))) {
    await pool.query(
      `UPDATE app.users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2
                             THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [row.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES]
    )
    return { ok: false, reason: "bad-credentials" }
  }
  if (row.disabled) return { ok: false, reason: "disabled" }

  if (row.failed_logins > 0 || row.locked_until) {
    await pool.query("UPDATE app.users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [row.id])
  }
  return { ok: true, user: { id: row.id, email: row.email, role: row.role } }
}

/** SHA-256 hex of a session token (what auth_sessions stores). */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Creates a session for a user and returns the bearer token (shown once). */
export async function createAuthSession(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.query(
    "INSERT INTO app.auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [tokenHash(token), userId, SESSION_DAYS]
  )
  return token
}

/** Resolves a token to its live user, or null (expired, revoked, disabled). */
export async function getSessionUser(pool: pg.Pool, token: string): Promise<AuthUser | null> {
  const result = await pool.query(
    `SELECT u.id, u.email, u.role FROM app.auth_sessions s
     JOIN app.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [tokenHash(token)]
  )
  return result.rows[0] ?? null
}

/** Revokes one session. */
export async function deleteAuthSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM app.auth_sessions WHERE token_hash = $1", [tokenHash(token)])
}

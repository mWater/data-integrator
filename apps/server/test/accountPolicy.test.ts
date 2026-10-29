import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { authenticate, createAuthSession, createUser, getSessionUser } from "../src/auth.js"
import { disableInactiveAccounts, parseAccountPolicy, saveAccountPolicy } from "../src/accountPolicy.js"
import { setDisabled } from "../src/users.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
})

beforeEach(async () => {
  await pool.query("DELETE FROM app.auth_sessions")
  await pool.query("DELETE FROM app.users")
  await pool.query("DELETE FROM app.settings")
})

/** Moves a user's clocks back by the given number of days. */
async function age(email: string, column: "password_changed_at" | "last_active_at", days: number): Promise<void> {
  await pool.query(`UPDATE app.users SET ${column} = now() - make_interval(days => $2) WHERE email = $1`, [email, days])
}

/** Signs in over HTTP and returns the response. */
function login(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
}

test("parseAccountPolicy: days or null, rejects junk", () => {
  assert.deepEqual(parseAccountPolicy({}), { passwordMaxAgeDays: null, inactiveDisableDays: null })
  assert.deepEqual(parseAccountPolicy({ passwordMaxAgeDays: 90, inactiveDisableDays: null }), {
    passwordMaxAgeDays: 90,
    inactiveDisableDays: null
  })
  assert.throws(() => parseAccountPolicy({ passwordMaxAgeDays: 0 }))
  assert.throws(() => parseAccountPolicy({ inactiveDisableDays: 1.5 }))
  assert.throws(() => parseAccountPolicy({ inactiveDisableDays: "30" }))
})

test("password expiry: off by default, enforced at sign-in when set", async () => {
  await createUser(pool, "old@example.org", "original-pass", "viewer")
  await age("old@example.org", "password_changed_at", 400)

  // Off by default: an old password still signs in
  assert.ok((await authenticate(pool, "old@example.org", "original-pass")).ok)

  await saveAccountPolicy(pool, { passwordMaxAgeDays: 90, inactiveDisableDays: null })
  assert.deepEqual(await authenticate(pool, "old@example.org", "original-pass"), { ok: false, reason: "password-expired" })
  // A wrong password still reads as bad credentials, not expired
  assert.deepEqual(await authenticate(pool, "old@example.org", "wrong-pass"), { ok: false, reason: "bad-credentials" })

  const expired = await login({ email: "old@example.org", password: "original-pass" })
  assert.equal(expired.status, 401)
  assert.equal((await expired.json()).code, "password_expired")
  assert.equal(expired.headers.get("set-cookie"), null)

  // The replacement must differ from the old password
  const same = await login({ email: "old@example.org", password: "original-pass", newPassword: "original-pass" })
  assert.equal(same.status, 400)
  // A wrong old password cannot set a new one
  const guess = await login({ email: "old@example.org", password: "wrong-pass", newPassword: "replacement-1" })
  assert.equal(guess.status, 401)

  const renewed = await login({ email: "old@example.org", password: "original-pass", newPassword: "replacement-1" })
  assert.equal(renewed.status, 200)
  assert.match(renewed.headers.get("set-cookie") ?? "", /di_session=/)
  assert.ok((await authenticate(pool, "old@example.org", "replacement-1")).ok)
})

test("inactivity: off by default; disables stale accounts and revokes sessions", async () => {
  await createUser(pool, "admin@example.org", "admin-pass-1", "admin")
  const stale = await createUser(pool, "stale@example.org", "stale-pass-1", "viewer")
  await createUser(pool, "fresh@example.org", "fresh-pass-1", "viewer")
  const session = await createAuthSession(pool, stale.id)
  await age("stale@example.org", "last_active_at", 100)

  assert.equal(await disableInactiveAccounts(pool), 0)

  await saveAccountPolicy(pool, { passwordMaxAgeDays: null, inactiveDisableDays: 30 })
  assert.equal(await disableInactiveAccounts(pool), 1)
  const rows = await pool.query("SELECT email FROM app.users WHERE disabled ORDER BY email")
  assert.deepEqual(rows.rows.map(r => r.email), ["stale@example.org"])
  assert.equal(await getSessionUser(pool, session), null)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.auth_sessions")).rows[0].n, 0)

  // Re-enabling restarts the clock, so the next sweep leaves it alone
  assert.ok((await setDisabled(pool, stale.id, false)).ok)
  assert.equal(await disableInactiveAccounts(pool), 0)
})

test("inactivity: never disables the last active admin", async () => {
  await saveAccountPolicy(pool, { passwordMaxAgeDays: null, inactiveDisableDays: 30 })
  await createUser(pool, "a1@example.org", "admin-pass-1", "admin")
  await createUser(pool, "a2@example.org", "admin-pass-2", "admin")
  await age("a1@example.org", "last_active_at", 100)
  await age("a2@example.org", "last_active_at", 100)

  // Every admin is stale: none is disabled
  assert.equal(await disableInactiveAccounts(pool), 0)

  // Once one admin is active again, the stale one goes
  await age("a2@example.org", "last_active_at", 0)
  assert.equal(await disableInactiveAccounts(pool), 1)
  const disabled = await pool.query("SELECT email FROM app.users WHERE disabled")
  assert.deepEqual(disabled.rows.map(r => r.email), ["a1@example.org"])
})

test("session use counts as activity", async () => {
  const user = await createUser(pool, "busy@example.org", "busy-pass-1", "viewer")
  const session = await createAuthSession(pool, user.id)
  await age("busy@example.org", "last_active_at", 100)
  assert.equal((await getSessionUser(pool, session))?.email, "busy@example.org")
  const row = await pool.query("SELECT last_active_at > now() - interval '1 minute' AS fresh FROM app.users WHERE id = $1", [
    user.id
  ])
  assert.equal(row.rows[0].fresh, true)
})

test("http: only admins read or change the policy", async () => {
  await createUser(pool, "boss@example.org", "boss-pass-1", "admin")
  await createUser(pool, "ed@example.org", "editor-pass-1", "editor")
  const cookie = async (email: string, password: string) =>
    ((await login({ email, password })).headers.get("set-cookie") ?? "").split(";")[0]
  const admin = await cookie("boss@example.org", "boss-pass-1")
  const editor = await cookie("ed@example.org", "editor-pass-1")

  const refused = await fetch(`${base}/api/settings/account_policy`, {
    method: "PUT",
    headers: { cookie: editor, "content-type": "application/json" },
    body: JSON.stringify({ passwordMaxAgeDays: 1 })
  })
  assert.equal(refused.status, 403)
  assert.equal((await fetch(`${base}/api/settings/account_policy`, { headers: { cookie: editor } })).status, 403)

  const saved = await fetch(`${base}/api/settings/account_policy`, {
    method: "PUT",
    headers: { cookie: admin, "content-type": "application/json" },
    body: JSON.stringify({ passwordMaxAgeDays: 180, inactiveDisableDays: 90 })
  })
  assert.equal(saved.status, 200)
  assert.deepEqual((await saved.json()).policy, { passwordMaxAgeDays: 180, inactiveDisableDays: 90 })

  const bad = await fetch(`${base}/api/settings/account_policy`, {
    method: "PUT",
    headers: { cookie: admin, "content-type": "application/json" },
    body: JSON.stringify({ passwordMaxAgeDays: -1 })
  })
  assert.equal(bad.status, 400)
})

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import {
  authenticate,
  createAuthSession,
  createUser,
  deleteAuthSession,
  getSessionUser,
  hashPassword,
  setPassword,
  verifyPassword
} from "../src/auth.js"
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

test("password hash round-trip; wrong password rejected", async () => {
  const stored = await hashPassword("correct horse")
  assert.ok(stored.startsWith("scrypt:"))
  assert.equal(await verifyPassword(stored, "correct horse"), true)
  assert.equal(await verifyPassword(stored, "wrong horse"), false)
})

test("authenticate: success, case-insensitive email, bad password, lockout", async () => {
  await createUser(pool, "ops@example.org", "hunter2hunter2", "editor")

  const ok = await authenticate(pool, "OPS@Example.org", "hunter2hunter2")
  assert.ok(ok.ok && ok.user.role === "editor")

  const bad = await authenticate(pool, "ops@example.org", "nope-nope")
  assert.deepEqual(bad, { ok: false, reason: "bad-credentials" })

  // Drive the counter to the threshold; the next attempt reports locked
  await pool.query("UPDATE app.users SET failed_logins = 9 WHERE email = 'ops@example.org'")
  await authenticate(pool, "ops@example.org", "nope-nope")
  const locked = await authenticate(pool, "ops@example.org", "hunter2hunter2")
  assert.deepEqual(locked, { ok: false, reason: "locked" })

  // setPassword clears the lockout
  await setPassword(pool, "ops@example.org", "new-password-1")
  const after = await authenticate(pool, "ops@example.org", "new-password-1")
  assert.ok(after.ok)
})

test("sessions: validate, revoke, expiry, disabled user", async () => {
  const user = await createUser(pool, "sess@example.org", "hunter2hunter2", "viewer")

  const token = await createAuthSession(pool, user.id)
  assert.equal((await getSessionUser(pool, token))?.email, "sess@example.org")
  assert.equal(await getSessionUser(pool, "not-a-token"), null)

  await deleteAuthSession(pool, token)
  assert.equal(await getSessionUser(pool, token), null)

  const expired = await createAuthSession(pool, user.id)
  await pool.query("UPDATE app.auth_sessions SET expires_at = now() - interval '1 minute'")
  assert.equal(await getSessionUser(pool, expired), null)

  const active = await createAuthSession(pool, user.id)
  await pool.query("UPDATE app.users SET disabled = true WHERE id = $1", [user.id])
  assert.equal(await getSessionUser(pool, active), null)
})

test("http: login sets cookie, data routes gate on it, viewer blocked from design", async () => {
  await createUser(pool, "web@example.org", "hunter2hunter2", "viewer")

  const noAuth = await fetch(`${base}/api/integrations`)
  assert.equal(noAuth.status, 401)

  const badLogin = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "web@example.org", password: "wrong" })
  })
  assert.equal(badLogin.status, 401)

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "web@example.org", password: "hunter2hunter2" })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie") ?? ""
  assert.match(cookie, /di_session=.+HttpOnly/)
  const cookieHeader = cookie.split(";")[0]

  const me = await fetch(`${base}/api/me`, { headers: { cookie: cookieHeader } })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).user.role, "viewer")

  const data = await fetch(`${base}/api/integrations`, { headers: { cookie: cookieHeader } })
  assert.equal(data.status, 200)

  const design = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ integrationId: "x" })
  })
  assert.equal(design.status, 403)

  const run = await fetch(`${base}/api/integrations/anything/run`, {
    method: "POST",
    headers: { cookie: cookieHeader }
  })
  assert.equal(run.status, 403)

  const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie: cookieHeader } })
  assert.equal(logout.status, 200)
  const afterLogout = await fetch(`${base}/api/me`, { headers: { cookie: cookieHeader } })
  assert.equal(afterLogout.status, 401)
})

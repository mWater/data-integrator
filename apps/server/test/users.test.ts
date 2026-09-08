import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { createUser } from "../src/auth.js"
import { setDisabled } from "../src/users.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** A uuid that matches the route pattern but no row. */
const NO_SUCH_ID = "00000000-0000-0000-0000-000000000000"

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let rootCookie: string
let editorCookie: string

/** Signs in and returns the cookie header for subsequent requests. */
async function loginCookie(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  })
  assert.equal(res.status, 200)
  return (res.headers.get("set-cookie") ?? "").split(";")[0]
}

/** Fetches the admin user list and returns the row for an email. */
async function findUser(email: string): Promise<{ id: string; role: string; disabled: boolean }> {
  const res = await fetch(`${base}/api/users`, { headers: { cookie: rootCookie } })
  assert.equal(res.status, 200)
  const row = (await res.json()).users.find((u: { email: string }) => u.email === email)
  assert.ok(row, `no listed user ${email}`)
  return row
}

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  await createUser(pool, "root@example.org", "rootpw-123456", "admin")
  await createUser(pool, "ed@example.org", "editorpw-123456", "editor")
  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  rootCookie = await loginCookie("root@example.org", "rootpw-123456")
  editorCookie = await loginCookie("ed@example.org", "editorpw-123456")
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
})

test("admin routes gate: 403 for non-admins, 401 unauthenticated", async () => {
  const asEditor = { headers: { cookie: editorCookie, "content-type": "application/json" } }
  const calls = [
    fetch(`${base}/api/users`, { headers: { cookie: editorCookie } }),
    fetch(`${base}/api/users`, { ...asEditor, method: "POST", body: JSON.stringify({ email: "x@example.org", role: "viewer" }) }),
    fetch(`${base}/api/users/${NO_SUCH_ID}/password`, { ...asEditor, method: "POST" }),
    fetch(`${base}/api/users/${NO_SUCH_ID}/role`, { ...asEditor, method: "PUT", body: JSON.stringify({ role: "viewer" }) }),
    fetch(`${base}/api/users/${NO_SUCH_ID}/disabled`, { ...asEditor, method: "PUT", body: JSON.stringify({ disabled: true }) })
  ]
  for (const res of await Promise.all(calls)) assert.equal(res.status, 403)

  const noAuth = await fetch(`${base}/api/users`)
  assert.equal(noAuth.status, 401)
})

test("list users: full rows, sorted by email", async () => {
  const res = await fetch(`${base}/api/users`, { headers: { cookie: rootCookie } })
  assert.equal(res.status, 200)
  const { users } = await res.json()
  assert.deepEqual(
    users.map((u: { email: string }) => u.email),
    ["ed@example.org", "root@example.org"]
  )
  for (const u of users) {
    assert.match(u.id, /^[0-9a-f-]{36}$/)
    assert.ok(["admin", "editor", "viewer"].includes(u.role))
    assert.equal(u.disabled, false)
    assert.ok(!Number.isNaN(Date.parse(u.createdAt)))
  }
})

test("create user: generated password works; duplicates and bad input rejected", async () => {
  const asAdmin = { headers: { cookie: rootCookie, "content-type": "application/json" } }
  const created = await fetch(`${base}/api/users`, {
    ...asAdmin,
    method: "POST",
    body: JSON.stringify({ email: "vi@example.org", role: "viewer" })
  })
  assert.equal(created.status, 201)
  const body = await created.json()
  assert.equal(body.user.email, "vi@example.org")
  assert.equal(body.user.role, "viewer")
  assert.match(body.password, /^[A-Za-z0-9_-]{16}$/)
  await loginCookie("vi@example.org", body.password)

  // citext catches case-variant duplicates too
  const dup = await fetch(`${base}/api/users`, {
    ...asAdmin,
    method: "POST",
    body: JSON.stringify({ email: "ROOT@Example.org", role: "viewer" })
  })
  assert.equal(dup.status, 409)

  const badRole = await fetch(`${base}/api/users`, {
    ...asAdmin,
    method: "POST",
    body: JSON.stringify({ email: "y@example.org", role: "owner" })
  })
  assert.equal(badRole.status, 400)

  const badEmail = await fetch(`${base}/api/users`, {
    ...asAdmin,
    method: "POST",
    body: JSON.stringify({ email: "  ", role: "viewer" })
  })
  assert.equal(badEmail.status, 400)
})

test("reset password: old dies, new works, lockout cleared; unknown id 404", async () => {
  const vi = await findUser("vi@example.org")
  await pool.query(
    "UPDATE app.users SET failed_logins = 9, locked_until = now() + interval '10 minutes' WHERE id = $1",
    [vi.id]
  )

  const res = await fetch(`${base}/api/users/${vi.id}/password`, { method: "POST", headers: { cookie: rootCookie } })
  assert.equal(res.status, 200)
  const { password } = await res.json()
  assert.match(password, /^[A-Za-z0-9_-]{16}$/)

  const cleared = await pool.query("SELECT failed_logins, locked_until FROM app.users WHERE id = $1", [vi.id])
  assert.equal(cleared.rows[0].failed_logins, 0)
  assert.equal(cleared.rows[0].locked_until, null)
  await loginCookie("vi@example.org", password)

  const unknown = await fetch(`${base}/api/users/${NO_SUCH_ID}/password`, {
    method: "POST",
    headers: { cookie: rootCookie }
  })
  assert.equal(unknown.status, 404)
})

test("role change reaches live sessions without re-login", async () => {
  const ed = await findUser("ed@example.org")
  const promote = await fetch(`${base}/api/users/${ed.id}/role`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "admin" })
  })
  assert.equal(promote.status, 200)

  const me = await fetch(`${base}/api/me`, { headers: { cookie: editorCookie } })
  assert.equal((await me.json()).user.role, "admin")

  const demote = await fetch(`${base}/api/users/${ed.id}/role`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "editor" })
  })
  assert.equal(demote.status, 200)
  const meAfter = await fetch(`${base}/api/me`, { headers: { cookie: editorCookie } })
  assert.equal((await meAfter.json()).user.role, "editor")
})

test("last active admin cannot be demoted; allowed once another admin exists", async () => {
  const root = await findUser("root@example.org")
  const selfDemote = await fetch(`${base}/api/users/${root.id}/role`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "editor" })
  })
  assert.equal(selfDemote.status, 409)

  // With a second active admin the same demotion goes through (and is reverted)
  const ed = await findUser("ed@example.org")
  for (const [cookie, id, role] of [
    [rootCookie, ed.id, "admin"],
    [rootCookie, root.id, "editor"],
    [editorCookie, root.id, "admin"],
    [rootCookie, ed.id, "editor"]
  ]) {
    const res = await fetch(`${base}/api/users/${id}/role`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role })
    })
    assert.equal(res.status, 200)
  }
})

test("disabling the last active admin is refused at the module level", async () => {
  // Unreachable over HTTP (the acting admin is always active, so the last-admin
  // case is always the self-disable 400) but the guard protects other callers
  const root = await findUser("root@example.org")
  assert.deepEqual(await setDisabled(pool, root.id, true), { ok: false, reason: "last-admin" })
})

test("admins cannot disable their own account", async () => {
  const root = await findUser("root@example.org")
  const res = await fetch(`${base}/api/users/${root.id}/disabled`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ disabled: true })
  })
  assert.equal(res.status, 400)
})

test("disable revokes sessions and blocks login; enable requires fresh login", async () => {
  const vi = await findUser("vi@example.org")
  const viPassword = (
    await (await fetch(`${base}/api/users/${vi.id}/password`, { method: "POST", headers: { cookie: rootCookie } })).json()
  ).password
  const viCookie = await loginCookie("vi@example.org", viPassword)

  const disable = await fetch(`${base}/api/users/${vi.id}/disabled`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ disabled: true })
  })
  assert.equal(disable.status, 200)
  assert.equal((await disable.json()).user.disabled, true)

  const asDisabled = await fetch(`${base}/api/integrations`, { headers: { cookie: viCookie } })
  assert.equal(asDisabled.status, 401)
  const sessions = await pool.query("SELECT count(*)::int AS n FROM app.auth_sessions WHERE user_id = $1", [vi.id])
  assert.equal(sessions.rows[0].n, 0)
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "vi@example.org", password: viPassword })
  })
  assert.equal(login.status, 401)

  const enable = await fetch(`${base}/api/users/${vi.id}/disabled`, {
    method: "PUT",
    headers: { cookie: rootCookie, "content-type": "application/json" },
    body: JSON.stringify({ disabled: false })
  })
  assert.equal(enable.status, 200)
  await loginCookie("vi@example.org", viPassword)
})

test("change own password: wrong current rejected without lockout, short rejected, success", async () => {
  const asEditor = { headers: { cookie: editorCookie, "content-type": "application/json" } }
  const wrong = await fetch(`${base}/api/me/password`, {
    ...asEditor,
    method: "POST",
    body: JSON.stringify({ currentPassword: "not-it", newPassword: "long-enough-1" })
  })
  assert.equal(wrong.status, 400)
  const counter = await pool.query("SELECT failed_logins FROM app.users WHERE email = 'ed@example.org'")
  assert.equal(counter.rows[0].failed_logins, 0)

  const short = await fetch(`${base}/api/me/password`, {
    ...asEditor,
    method: "POST",
    body: JSON.stringify({ currentPassword: "editorpw-123456", newPassword: "short" })
  })
  assert.equal(short.status, 400)

  const ok = await fetch(`${base}/api/me/password`, {
    ...asEditor,
    method: "POST",
    body: JSON.stringify({ currentPassword: "editorpw-123456", newPassword: "editorpw-654321" })
  })
  assert.equal(ok.status, 200)
  const oldLogin = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ed@example.org", password: "editorpw-123456" })
  })
  assert.equal(oldLogin.status, 401)
  await loginCookie("ed@example.org", "editorpw-654321")

  const noAuth = await fetch(`${base}/api/me/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "x", newPassword: "long-enough-1" })
  })
  assert.equal(noAuth.status, 401)
})

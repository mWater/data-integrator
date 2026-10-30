import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { createUser } from "../src/auth.js"
import { loggablePath } from "../src/securityLog.js"
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

/** Runs fn and returns the security events written to stdout meanwhile. */
async function captureEvents(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk)
    if (text.includes('"type":"security"')) {
      lines.push(text)
      return true
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    await fn()
    // Write events log on response finish, which can trail the client's read
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    process.stdout.write = write
  }
  return lines.flatMap(l => l.trim().split("\n")).map(l => JSON.parse(l))
}

/** POSTs or PUTs JSON. */
function send(method: string, url: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  })
}

test("loggablePath drops query strings and redacts webhook tokens", () => {
  assert.equal(loggablePath("/api/users?x=1"), "/api/users")
  assert.equal(loggablePath("/hooks/abcdef0123456789"), "/hooks/[redacted]")
})

test("sign-in outcomes, writes and refusals are logged without secrets", async () => {
  const admin = await createUser(pool, "root@example.org", "admin-pass-1", "admin")
  const viewer = await createUser(pool, "reader@example.org", "viewer-pass-1", "viewer")

  let adminCookie = ""
  let viewerCookie = ""
  const events = await captureEvents(async () => {
    await send("POST", "/api/login", { email: "root@example.org", password: "wrong-password" })
    adminCookie = ((await send("POST", "/api/login", { email: "root@example.org", password: "admin-pass-1" })).headers.get("set-cookie") ?? "").split(";")[0]
    viewerCookie = ((await send("POST", "/api/login", { email: "reader@example.org", password: "viewer-pass-1" })).headers.get("set-cookie") ?? "").split(";")[0]
    assert.equal((await send("PUT", `/api/users/${viewer.id}/role`, { role: "editor" }, adminCookie)).status, 200)
    assert.equal((await send("PUT", `/api/users/${admin.id}/role`, { role: "viewer" }, viewerCookie)).status, 403)
    assert.equal((await send("POST", "/api/me/password", { currentPassword: "viewer-pass-1", newPassword: "viewer-pass-2" }, viewerCookie)).status, 200)
  })

  const logins = events.filter(e => e.event === "auth.login")
  assert.deepEqual(logins.map(e => e.outcome), ["bad-credentials", "success", "success"])
  assert.equal(logins[0].email, "root@example.org")
  assert.equal(logins[1].userId, admin.id)

  const writes = events.filter(e => e.event === "api.write")
  const roleChange = writes.find(e => e.path === `/api/users/${viewer.id}/role`)
  assert.equal(roleChange?.status, 200)
  assert.equal(roleChange?.userId, admin.id)
  const refused = writes.find(e => e.path === `/api/users/${admin.id}/role`)
  assert.equal(refused?.status, 403)
  assert.equal(refused?.userId, viewer.id)
  assert.ok(writes.some(e => e.path === "/api/me/password" && e.status === 200))

  // No password, old or new, reaches the log
  const text = JSON.stringify(events)
  for (const secret of ["wrong-password", "admin-pass-1", "viewer-pass-1", "viewer-pass-2"]) assert.ok(!text.includes(secret))
})

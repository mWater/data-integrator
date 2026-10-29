import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import pg from "pg"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { installIntegration } from "../src/install.js"
import { copySecret, deleteSecret, getSecrets, listAllSecrets, setSecret } from "../src/secrets.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** Minimal secrets-declaring definition. */
function definitionWith(id: string, secrets: string[]): IntegrationDefinition {
  return {
    id,
    name: { _base: "en", en: id },
    trigger: {},
    runtime: "node",
    destinations: [],
    secrets,
    code: "export default async function run() { return {} }",
    contract: 2
  }
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let adminBearer: string
let viewerBearer: string
const key = randomBytes(32)

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  process.env.INTEGRATOR_SECRET_KEY = key.toString("hex")

  const admin = await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")
  adminBearer = await createApiToken(pool, admin.id, "admin-token")
  const viewer = await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")
  viewerBearer = await createApiToken(pool, viewer.id, "viewer-token")

  await installIntegration(pool, definitionWith("owner_a", ["api_key"]))
  await installIntegration(pool, definitionWith("claimant_b", ["api_key"]))

  server = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  delete process.env.INTEGRATOR_SECRET_KEY
  server?.close()
  await pool?.end()
  await db?.stop()
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

test("secrets are confined to their owning integration", async () => {
  await setSecret(pool, key, "owner_a", "api_key", "s3cr3t-value")
  assert.deepEqual(await getSecrets(pool, key, "owner_a", ["api_key"]), { api_key: "s3cr3t-value" })
  // claimant_b declares the same name but owns no value: it must NOT resolve
  await assert.rejects(
    () => getSecrets(pool, key, "claimant_b", ["api_key"]),
    /not set for this integration/
  )
})

test("copy duplicates a value server-side under a fresh envelope", async () => {
  assert.equal(await copySecret(pool, key, "owner_a", "claimant_b", "api_key"), true)
  assert.deepEqual(await getSecrets(pool, key, "claimant_b", ["api_key"]), { api_key: "s3cr3t-value" })
  const rows = await pool.query("SELECT value FROM app.integration_secrets WHERE name = 'api_key'")
  assert.notDeepEqual(rows.rows[0].value, rows.rows[1].value)
  assert.equal(await copySecret(pool, key, "owner_a", "claimant_b", "nope"), false)
  assert.equal(await deleteSecret(pool, "claimant_b", "api_key"), true)
})

test("routes: admin sets and deletes, names listed without values, viewers denied", async () => {
  const put = await call("/api/integrations/owner_a/secrets/token_two", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ value: "another\nmultiline value" })
  })
  assert.equal(put.status, 200)

  const list = await (await call("/api/integrations/owner_a/secrets", adminBearer)).json()
  const names = list.secrets.map((s: { name: string }) => s.name).sort()
  assert.deepEqual(names, ["api_key", "token_two"])
  assert.ok(!JSON.stringify(list).includes("s3cr3t"), "values never appear in listings")

  const all = await (await call("/api/secrets", adminBearer)).json()
  assert.ok(all.secrets.every((s: { integrationId: string }) => typeof s.integrationId === "string"))

  assert.equal((await call("/api/integrations/owner_a/secrets", viewerBearer)).status, 403)
  assert.equal(
    (await call("/api/integrations/owner_a/secrets/x", viewerBearer, { method: "PUT", body: "{}" })).status,
    403
  )
  assert.equal((await call("/api/integrations/nope/secrets/x", adminBearer, { method: "PUT", body: JSON.stringify({ value: "v" }) })).status, 404)

  const del = await call("/api/integrations/owner_a/secrets/token_two", adminBearer, { method: "DELETE" })
  assert.equal(del.status, 200)

  // Environment-variable style names are accepted alongside the lowercase convention
  const upper = await call("/api/integrations/owner_a/secrets/WEATHER_API_KEY", adminBearer, {
    method: "PUT",
    body: JSON.stringify({ value: "k" })
  })
  assert.equal(upper.status, 200)
  assert.deepEqual(await getSecrets(pool, key, "owner_a", ["WEATHER_API_KEY"]), { WEATHER_API_KEY: "k" })
  assert.equal(
    (await call("/api/integrations/owner_a/secrets/WEATHER_API_KEY", adminBearer, { method: "DELETE" })).status,
    200
  )
})

test("cascade: deleting the integration removes its secrets", async () => {
  await installIntegration(pool, definitionWith("doomed", ["k"]))
  await setSecret(pool, key, "doomed", "k", "v")
  const { deleteIntegration } = await import("../src/install.js")
  await deleteIntegration(pool, "doomed")
  const rows = await listAllSecrets(pool)
  assert.ok(!rows.some(r => r.integrationId === "doomed"))
})

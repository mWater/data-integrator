import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration } from "../src/install.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** A draft as a design session first saves it. */
const DRAFT: IntegrationDefinition = {
  id: "versioned",
  name: { _base: "en", en: "Versioned" },
  trigger: {},
  runtime: "python",
  destinations: [{ kind: "table", tableId: "versioned_rows", action: "append", columns: [{ id: "site", type: "text" }] }],
  code: "def run(ctx): return {}",
  contract: 2
}

let db: TestDb
let pool: pg.Pool

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

test("install archives what the row holds when a design session rewrote it in place", async () => {
  assert.equal((await installIntegration(pool, DRAFT, "draft")).version, 1)
  // Design sessions write the draft's row directly, without archiving
  const edited = { ...DRAFT, code: "def run(ctx): return {'data': {}}" }
  await pool.query("UPDATE app.integrations SET definition = $2 WHERE id = $1", [DRAFT.id, JSON.stringify(edited)])

  // Finishing with that same definition must archive it, not reuse v1
  assert.equal((await installIntegration(pool, edited, "ready")).version, 2)
  const archived = await pool.query("SELECT definition->>'code' AS code FROM app.integration_versions WHERE integration_id = $1 AND version = 2", [DRAFT.id])
  assert.equal(archived.rows[0].code, edited.code)

  // A true re-install of the current version stays a no-op
  assert.equal((await installIntegration(pool, edited, "ready")).version, 2)
})

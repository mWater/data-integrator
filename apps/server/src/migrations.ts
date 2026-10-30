import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

/** Advisory lock key so concurrent server boots do not race migrations. */
const MIGRATION_LOCK = 749100211

/** Matches applyable migration files: numbered, .sql. */
const MIGRATION_FILE = /^\d+.*\.sql$/

/**
 * Applies pending migrations from a directory in filename order, each in its
 * own transaction, recording them in app.migrations. Forward-only. Run by
 * `cli.js migrate`; an advisory lock serializes concurrent runners.
 *
 * @returns Names of the migrations applied by this call.
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK])
    await client.query("CREATE SCHEMA IF NOT EXISTS app")
    await client.query(
      `CREATE TABLE IF NOT EXISTS app.migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`
    )

    const files = (await readdir(dir)).filter(f => MIGRATION_FILE.test(f)).sort()
    const appliedResult = await client.query("SELECT name FROM app.migrations")
    const applied = new Set(appliedResult.rows.map(r => r.name as string))

    const ran: string[] = []
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(path.join(dir, file), "utf8")
      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("INSERT INTO app.migrations (name) VALUES ($1)", [file])
        await client.query("COMMIT")
      } catch (err) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      ran.push(file)
    }
    return ran
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {})
    client.release()
  }
}

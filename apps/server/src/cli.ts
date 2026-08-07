#!/usr/bin/env node
/**
 * Server CLI. Commands:
 *   migrate    Apply pending migrations (DATABASE_URL required).
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPool } from "./db.js"
import { migrate } from "./migrations.js"

/** Directory holding the numbered .sql migration files. */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

async function main(): Promise<number> {
  const command = process.argv[2]
  if (command !== "migrate") {
    console.error("Usage: cli.js migrate")
    return 1
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error("DATABASE_URL is required")
    return 1
  }

  const pool = createPool(databaseUrl)
  try {
    const ran = await migrate(pool, MIGRATIONS_DIR)
    console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Up to date")
    return 0
  } finally {
    await pool.end()
  }
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
)

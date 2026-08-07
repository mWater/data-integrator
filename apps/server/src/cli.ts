#!/usr/bin/env node
/**
 * Server CLI. Commands (DATABASE_URL required for all):
 *   migrate                 Apply pending migrations.
 *   install <file>          Install/update an integration from a definition JSON file.
 *   run <integrationId>     Enqueue a manual run and execute it to completion.
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { hostname } from "node:os"
import { fileURLToPath } from "node:url"
import { Runner } from "@data-integrator/runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { createPool } from "./db.js"
import { migrate } from "./migrations.js"
import { installIntegration } from "./install.js"
import { claimNextRun, executeRun } from "./executor.js"
import { RasterStore } from "./rasterStore.js"
import { loadSecretKey } from "./secrets.js"
import { TileRenderer } from "./tiles.js"
import { createApiServer } from "./server.js"

/** Directory holding the numbered .sql migration files. */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/**
 * Loads a definition from a JSON file, or from a library directory holding
 * definition.json plus a code.py/code.mjs file that becomes definition.code.
 */
async function loadDefinition(target: string): Promise<IntegrationDefinition> {
  if (!(await stat(target)).isDirectory()) {
    return JSON.parse(await readFile(target, "utf8"))
  }
  const definition = JSON.parse(await readFile(path.join(target, "definition.json"), "utf8"))
  for (const codeFile of ["code.py", "code.mjs"]) {
    const code = await readFile(path.join(target, codeFile), "utf8").catch(() => null)
    if (code !== null) {
      definition.code = code
      return definition
    }
  }
  throw new Error(`No code.py or code.mjs in ${target}`)
}

async function main(): Promise<number> {
  const command = process.argv[2]
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error("DATABASE_URL is required")
    return 1
  }
  const pool = createPool(databaseUrl)

  try {
    switch (command) {
      case "migrate": {
        const ran = await migrate(pool, MIGRATIONS_DIR)
        console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Up to date")
        return 0
      }
      case "install": {
        const target = process.argv[3]
        if (!target) {
          console.error("Usage: cli.js install <definition.json | definition-dir>")
          return 1
        }
        const definition = await loadDefinition(target)
        const { hash } = await installIntegration(pool, definition)
        console.log(`Installed ${definition.id} (${hash.slice(0, 12)})`)
        return 0
      }
      case "run": {
        const integrationId = process.argv[3]
        if (!integrationId) {
          console.error("Usage: cli.js run <integrationId>")
          return 1
        }
        await pool.query(
          `INSERT INTO app.runs (integration_id, trigger, status) VALUES ($1, 'manual', 'queued')
           ON CONFLICT DO NOTHING`,
          [integrationId]
        )
        const runner = new Runner()
        await runner.ensureReady()
        const run = await claimNextRun(pool, `cli-${hostname()}`)
        if (!run) {
          console.error("Nothing claimable (already running?)")
          return 1
        }
        await executeRun(
          {
            pool,
            runner,
            store: new RasterStore(process.env.RASTER_STORE_PATH ?? "./raster-store"),
            workRoot: process.env.WORK_ROOT ?? "./work",
            secretKey: process.env.INTEGRATOR_SECRET_KEY ? loadSecretKey() : null,
            images: {
              "python3.12": process.env.RUNTIME_IMAGE_PYTHON ?? "localhost/integrator-runtime-python:dev",
              node22: process.env.RUNTIME_IMAGE_NODE ?? "localhost/integrator-runtime-node:dev"
            }
          },
          run
        )
        const final = await pool.query("SELECT status, error, stats FROM app.runs WHERE id = $1", [run.id])
        const { status, error, stats } = final.rows[0]
        console.log(`Run ${run.id}: ${status}${error ? ` (${error})` : ""} ${stats ? JSON.stringify(stats) : ""}`)
        return status === "succeeded" ? 0 : 1
      }
      case "serve": {
        const store = new RasterStore(process.env.RASTER_STORE_PATH ?? "./raster-store")
        const tiles = new TileRenderer(store, process.env.TILE_CACHE_PATH ?? "./tile-cache")
        const port = Number(process.env.PORT ?? 8080)
        createApiServer(pool, tiles).listen(port, () => {
          console.log(`Serving on http://127.0.0.1:${port}/map`)
        })
        return await new Promise<number>(() => {})
      }
      default:
        console.error("Usage: cli.js migrate | install <file|dir> | run <integrationId> | serve")
        return 1
    }
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

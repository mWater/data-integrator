#!/usr/bin/env node
/**
 * Server CLI. Commands (DATABASE_URL required for all):
 *   migrate                 Apply pending migrations.
 *   install <file>          Install/update an integration from a definition JSON file.
 *   run <integrationId>     Enqueue a manual run and execute it to completion.
 *   agent <id> [sessionId]  Interactive designer session for one integration.
 *   serve                   HTTP API and map page.
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { hostname } from "node:os"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { LanguageModel } from "ai"
import { Runner } from "@data-integrator/runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { createPool } from "./db.js"
import { migrate } from "./migrations.js"
import { installIntegration } from "./install.js"
import { claimNextRun, executeRun, ExecutorDeps } from "./executor.js"
import { RasterStore } from "./rasterStore.js"
import { loadSecretKey } from "./secrets.js"
import { TileRenderer } from "./tiles.js"
import { createApiServer } from "./server.js"
import { randomBytes } from "node:crypto"
import { createApiToken, createUser, setPassword } from "./auth.js"
import { AgentSessionController } from "./agent/controller.js"
import { DesignerImplementation, initialDesignerState } from "./agent/designer.js"
import { AgentService } from "./agent/service.js"
import { AgentEvent } from "./agent/types.js"
import { RunService } from "./runService.js"

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

/** Executor dependencies from environment configuration. */
function buildDeps(pool: ReturnType<typeof createPool>, runner: Runner): ExecutorDeps {
  return {
    pool,
    runner,
    databaseUrl: process.env.DATABASE_URL ?? "",
    store: new RasterStore(process.env.RASTER_STORE_PATH ?? "./raster-store"),
    workRoot: process.env.WORK_ROOT ?? "./work",
    secretKey: process.env.INTEGRATOR_SECRET_KEY ? loadSecretKey() : null,
    images: {
      "python3.12": process.env.RUNTIME_IMAGE_PYTHON ?? "localhost/integrator-runtime-python:dev",
      node22: process.env.RUNTIME_IMAGE_NODE ?? "localhost/integrator-runtime-node:dev"
    }
  }
}

/** Agent model from environment: OpenRouter when its key is set, else Anthropic. */
function buildModel(): LanguageModel | null {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (openrouterKey) {
    return createOpenRouter({ apiKey: openrouterKey })(process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5")
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })(process.env.AGENT_MODEL ?? "claude-sonnet-5")
  }
  return null
}

/** Prints agent events as an indented console transcript. */
function printAgentEvent(event: AgentEvent): void {
  if (event.type === "assistant_text") console.log(`\n${event.text}\n`)
  else if (event.type === "tool_start") {
    const input = JSON.stringify(event.input) ?? ""
    console.log(`  [${event.tool}] ${input.length > 120 ? input.slice(0, 120) + "..." : input}`)
  } else if (event.type === "tool_end") console.log(`  [${event.tool}] -> ${event.summary.split("\n")[0]}`)
  else if (event.type === "job_log") console.log(`    | ${event.line}`)
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
        await executeRun(buildDeps(pool, runner), run)
        const final = await pool.query("SELECT status, error, stats FROM app.runs WHERE id = $1", [run.id])
        const { status, error, stats } = final.rows[0]
        console.log(`Run ${run.id}: ${status}${error ? ` (${error})` : ""} ${stats ? JSON.stringify(stats) : ""}`)
        return status === "succeeded" ? 0 : 1
      }
      case "user": {
        const sub = process.argv[3]
        const email = process.argv[4]
        if (sub === "add" && email) {
          const role = process.argv[5] ?? "admin"
          if (!["admin", "editor", "viewer"].includes(role)) {
            console.error("Role must be admin, editor, or viewer")
            return 1
          }
          const password = randomBytes(12).toString("base64url")
          await createUser(pool, email, password, role as "admin" | "editor" | "viewer")
          console.log(`Created ${email} (${role})`)
          console.log(`Password (shown once): ${password}`)
          console.log(`Change it with: echo 'newpassword' | cli.js user passwd ${email}`)
          return 0
        }
        if (sub === "passwd" && email) {
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          const password = (await rl.question("New password: ")).trim()
          rl.close()
          if (password.length < 8) {
            console.error("Password must be at least 8 characters")
            return 1
          }
          if (!(await setPassword(pool, email, password))) {
            console.error(`No user ${email}`)
            return 1
          }
          console.log(`Password updated for ${email}`)
          return 0
        }
        if (sub === "list") {
          const users = await pool.query(
            "SELECT email, role, disabled, created_at FROM app.users ORDER BY created_at"
          )
          for (const u of users.rows) {
            console.log(`${u.email}  ${u.role}${u.disabled ? "  (disabled)" : ""}`)
          }
          return 0
        }
        if (sub === "token" && email) {
          const name = process.argv[5] ?? `cli-${new Date().toISOString().slice(0, 10)}`
          const found = await pool.query("SELECT id FROM app.users WHERE email = $1", [email])
          if (found.rows.length === 0) {
            console.error(`No user ${email}`)
            return 1
          }
          const bearer = await createApiToken(pool, found.rows[0].id, name)
          console.log(`Token '${name}' for ${email} (shown once):`)
          console.log(bearer)
          return 0
        }
        if ((sub === "disable" || sub === "enable") && email) {
          const result = await pool.query("UPDATE app.users SET disabled = $2, updated_at = now() WHERE email = $1", [
            email,
            sub === "disable"
          ])
          if ((result.rowCount ?? 0) === 0) {
            console.error(`No user ${email}`)
            return 1
          }
          console.log(`${sub === "disable" ? "Disabled" : "Enabled"} ${email}`)
          return 0
        }
        console.error(
          "Usage: cli.js user add <email> [role] | passwd <email> | list | token <email> [name] | disable <email> | enable <email>"
        )
        return 1
      }
      case "agent": {
        const integrationId = process.argv[3]
        const resumeSessionId = process.argv[4]
        if (!integrationId) {
          console.error("Usage: cli.js agent <integrationId> [sessionId]")
          return 1
        }
        const model = buildModel()
        if (!model) {
          console.error("Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY (AGENT_MODEL overrides the default model)")
          return 1
        }
        const runner = new Runner()
        await runner.ensureReady()
        const impl = new DesignerImplementation({ ...buildDeps(pool, runner), model })
        const controller = new AgentSessionController(pool, impl)
        const sessionId = resumeSessionId ?? (await controller.createSession(initialDesignerState(integrationId)))
        console.log(`Designer session ${sessionId} for '${integrationId}'.`)
        console.log(`Describe what to build. 'exit' leaves (resume with: cli.js agent ${integrationId} ${sessionId})`)

        const rl = createInterface({ input: process.stdin, output: process.stdout })
        try {
          for (;;) {
            const line = (await rl.question("> ")).trim()
            if (!line || line === "exit") return 0
            const stop = await controller.sendMessage(sessionId, line, printAgentEvent)
            if (stop.reason === "finished") {
              console.log("Session finished.")
              return 0
            }
            if (stop.reason === "step_limit") {
              console.log("Step limit reached; session paused.")
              return 1
            }
          }
        } finally {
          rl.close()
        }
      }
      case "serve": {
        const deps = buildDeps(pool, new Runner())
        const tiles = new TileRenderer(deps.store, process.env.TILE_CACHE_PATH ?? "./tile-cache")
        const model = buildModel()
        const agent = model ? new AgentService(pool, { ...deps, model }) : null
        const runService = new RunService(deps)
        const port = Number(process.env.PORT ?? 8080)
        createApiServer(pool, tiles, agent, runService, deps.store).listen(port, () => {
          console.log(`Serving on http://127.0.0.1:${port}${agent ? "" : " (no model configured; session API disabled)"}`)
        })
        return await new Promise<number>(() => {})
      }
      default:
        console.error("Usage: cli.js migrate | install <file|dir> | run <integrationId> | agent <integrationId> [sessionId] | serve")
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

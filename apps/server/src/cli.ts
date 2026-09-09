#!/usr/bin/env node
/**
 * Server CLI. Commands (DATABASE_URL required for all):
 *   migrate                 Apply pending migrations.
 *   install <file>          Install/update an integration from a definition JSON file.
 *   run <integrationId>     Enqueue a manual run and execute it to completion.
 *   agent [target]          Interactive designer session. No target starts a new
 *                           integration; an integration id edits it; a session
 *                           uuid resumes.
 *   register-rasters        Backfill the out-db SQL mirror of promoted snapshots.
 *   localize-library        Wrap and translate library entry text into every
 *                           supported locale (library authoring; needs a model).
 *   serve                   HTTP API and map page.
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { hostname } from "node:os"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { LanguageModel } from "ai"
import { Runner } from "@pathfinder/runner"
import { IntegrationDefinition } from "@pathfinder/definitions"
import { createPool } from "./db.js"
import { migrate } from "./migrations.js"
import { refreshAoi } from "./aoi.js"
import { getDefaultAoi } from "./settings.js"
import { installIntegration } from "./install.js"
import { claimNextRun, executeRun, ExecutorDeps } from "./executor.js"
import { RasterStore } from "./rasterStore.js"
import { TileRenderer } from "./tiles.js"
import { createApiServer } from "./server.js"
import { basemapConfigFrom, BasemapProxy } from "./basemap.js"
import { aiProvider, AppConfig, describeConfig, loadConfig } from "./config.js"
import { startScheduler } from "./scheduler.js"
import { registerMissingRasters } from "./rasterSql.js"
import { randomBytes } from "node:crypto"
import { createApiToken, createUser, setPassword } from "./auth.js"
import { AgentSessionController } from "./agent/controller.js"
import { DesignerImplementation } from "./agent/designer.js"
import { AgentService } from "./agent/service.js"
import { AgentEvent } from "./agent/types.js"
import { RunService } from "./runService.js"
import { skillsDir } from "./skills.js"
import { SUPPORTED_LOCALES } from "@pathfinder/definitions"
import { translateDefinition, wrapDefinitionStrings } from "./localizeCatalog.js"
import { readdir, writeFile } from "node:fs/promises"

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

/** Executor dependencies from the validated configuration. */
function buildDeps(pool: ReturnType<typeof createPool>, runner: Runner, config: AppConfig): ExecutorDeps {
  return {
    pool,
    runner,
    databaseUrl: config.databaseUrl,
    store: new RasterStore(config.rasterStorePath),
    workRoot: config.workRoot,
    secretKey: config.secretKey,
    images: {
      "python3.12": config.runtimeImages.python,
      node22: config.runtimeImages.node
    },
    workQuotaMb: config.workQuotaMb,
    minFreeDiskMb: config.minFreeDiskMb
  }
}

/** Default agent model (OpenRouter); see Quickstart "Choosing a model". */
const DEFAULT_MODEL = "openai/gpt-5.6-sol"

/** Agent model from configuration: a custom OpenAI-compatible endpoint wins, then OpenRouter, then Anthropic. */
function buildModel(config: AppConfig): LanguageModel | null {
  const { baseUrl, baseUrlKey, openrouterKey, anthropicKey, effort: configEffort } = config.agent
  if (baseUrl) {
    // Self-hosted or third-party endpoint (vLLM, Ollama, LiteLLM…); config
    // guarantees AGENT_MODEL is set. No effort/caching knobs: those vary by server.
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: baseUrl,
      ...(baseUrlKey ? { apiKey: baseUrlKey } : {})
    })
    return provider(config.agent.model!)
  }
  if (openrouterKey) {
    const modelId = config.agent.model ?? DEFAULT_MODEL
    // The default model runs at medium effort: high cost 6x for no visible gain
    const effort = configEffort ?? (modelId === DEFAULT_MODEL ? "medium" : undefined)
    // Anthropic only caches prompts on an explicit directive (OpenAI and Gemini
    // cache automatically); 1h TTL because sandbox jobs and user think-time
    // routinely outlast the 5m default
    const settings = {
      ...(modelId.startsWith("anthropic/")
        ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
        : {}),
      ...(effort ? { reasoning: { effort } } : {})
    }
    return createOpenRouter({ apiKey: openrouterKey })(modelId, settings)
  }
  if (anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })(config.agent.model ?? "claude-sonnet-5")
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
  else if (event.type === "integration_bound") console.log(`  (integration named '${event.integrationId}')`)
}

/** A question the session is paused on, with its selectable options. */
interface PendingQuestion {
  /** Question text (markdown, printed raw) */
  question: string
  /** Answer choices, selectable by number */
  options: string[]
}

/** Prints an ask_user question with numbered options. */
function printQuestion(pending: PendingQuestion): void {
  console.log(`\n${pending.question}`)
  pending.options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`))
  console.log("(answer with a number or type your own reply)")
}

/**
 * The unanswered ask_user question a resumed session is paused on, if any:
 * the last assistant ask_user call with no user message after it.
 */
function pendingQuestionIn(messages: unknown[]): PendingQuestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown }
    if (message.role === "user") return null
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content as { type?: string; toolName?: string; input?: unknown }[]) {
      if (part.type === "tool-call" && part.toolName === "ask_user") {
        const input = part.input as { question?: string; options?: string[] }
        return { question: input.question ?? "", options: input.options ?? [] }
      }
    }
    return null
  }
  return null
}

async function main(): Promise<number> {
  const command = process.argv[2]
  let config: AppConfig
  try {
    config = loadConfig()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  const pool = createPool(config.databaseUrl)

  try {
    switch (command) {
      case "migrate": {
        const ran = await migrate(pool, MIGRATIONS_DIR)
        console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Up to date")
        // The area-of-interest shape derives from a setting; rebuild it so a
        // fresh or upgraded database has it before anything queries
        await refreshAoi(pool, await getDefaultAoi(pool))
        return 0
      }
      case "install": {
        const target = process.argv[3]
        if (!target) {
          console.error("Usage: cli.js install <definition.json | definition-dir>")
          return 1
        }
        const definition = await loadDefinition(target)
        const { version } = await installIntegration(pool, definition)
        console.log(`Installed ${definition.id} (v${version})`)
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
        await executeRun(buildDeps(pool, runner, config), run)
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
        const target = process.argv[3]
        const model = buildModel(config)
        if (!model) {
          console.error("Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or LLM_BASE_URL (AGENT_MODEL overrides the default model)")
          return 1
        }
        const runner = new Runner()
        await runner.ensureReady()
        const deps = { ...buildDeps(pool, runner, config), model, skillsDir: skillsDir(config.libraryPath), libraryPath: config.libraryPath }
        const controller = new AgentSessionController(pool, new DesignerImplementation(deps))
        const service = AgentService.forDesigner(pool, deps)

        // Dispatch on the target's shape: session uuid resumes, integration id
        // edits, nothing starts a new integration the agent will name
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        let sessionId: string
        let pending: PendingQuestion | null = null
        if (target && UUID.test(target)) {
          sessionId = target
          const detail = await service.getSession(sessionId)
          if (!detail) {
            console.error(`No session ${sessionId}`)
            return 1
          }
          console.log(`Resuming session ${sessionId}${detail.integrationId ? ` ('${detail.integrationId}')` : ""}.`)
          pending = pendingQuestionIn(detail.messages)
          if (pending) printQuestion(pending)
        } else {
          sessionId = await service.createSession(target)
          console.log(target ? `Editing '${target}'; session ${sessionId}.` : `New integration; session ${sessionId}.`)
        }
        console.log(`Describe what to build. 'exit' leaves (resume with: cli.js agent ${sessionId})`)

        const printEvent = (event: AgentEvent): void => {
          if (event.type === "tool_start" && event.tool === "ask_user") {
            const input = event.input as { question?: string; options?: string[] }
            pending = { question: input.question ?? "", options: input.options ?? [] }
            return
          }
          if (event.type === "tool_end" && event.tool === "ask_user") return
          printAgentEvent(event)
        }

        const rl = createInterface({ input: process.stdin, output: process.stdout })
        try {
          for (;;) {
            // Piped stdin ends by closing readline; treat that as a clean exit
            const line = await rl.question("> ").then(l => l.trim(), () => "exit")
            if (!line || line === "exit") return 0
            let text = line
            if (pending) {
              const n = Number(line)
              if (Number.isInteger(n) && n >= 1 && n <= pending.options.length) text = pending.options[n - 1]
              pending = null
            }
            const messageSentAt = new Date()
            const stop = await controller.sendMessage(sessionId, text, printEvent)
            if (stop.reason === "finished") {
              console.log("Session finished.")
              // finish may have started the first production load in this
              // process; wait for it so exiting does not strand the run. Only
              // runs created after the finish count: an edit of an installed
              // integration enqueues nothing, and reporting its previous run
              // as "First load" misleads.
              const detail = await service.getSession(sessionId)
              if (detail?.integrationId) {
                for (;;) {
                  const active = await pool.query(
                    "SELECT status FROM app.runs WHERE integration_id = $1 AND status IN ('queued', 'running')",
                    [detail.integrationId]
                  )
                  if (active.rows.length === 0) break
                  console.log("Waiting for the first data load to complete…")
                  await new Promise(resolve => setTimeout(resolve, 5000))
                }
                const last = await pool.query(
                  "SELECT status, error FROM app.runs WHERE integration_id = $1 AND COALESCE(started_at, scheduled_at) >= $2 ORDER BY scheduled_at DESC LIMIT 1",
                  [detail.integrationId, messageSentAt]
                )
                if (last.rows.length > 0) {
                  console.log(`First load: ${last.rows[0].status}${last.rows[0].error ? ` (${last.rows[0].error.split("\n")[0]})` : ""}`)
                } else {
                  console.log("No data load was queued by this session; run the integration manually or wait for its schedule.")
                }
              }
              return 0
            }
            if (stop.reason === "step_limit") {
              console.log("Step limit reached; session paused.")
              return 1
            }
            if (pending) printQuestion(pending)
          }
        } finally {
          rl.close()
        }
      }
      case "register-rasters": {
        // Backfill/repair the out-db SQL mirror of promoted snapshots
        const store = new RasterStore(config.rasterStorePath)
        const result = await registerMissingRasters(pool, rel => store.absolute(rel))
        console.log(`Registered ${result.registered}, pruned ${result.pruned}`)
        for (const failure of result.failures) console.error(`  failed: ${failure}`)
        return result.failures.length > 0 ? 1 : 0
      }
      case "localize-library": {
        // Library authoring: entries ship fully localized at the release
        // ceiling, so subset deployments find their languages present and
        // update detection stays quiet (canonical identity ignores
        // translations anyway). Rewrites each definition.json in place.
        const model = buildModel(config)
        if (!model) {
          console.error("Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or LLM_BASE_URL")
          return 1
        }
        const root = path.join(process.argv[3] ?? config.libraryPath, process.argv[3] ? "" : "integrations")
        const targets = SUPPORTED_LOCALES.map(l => l.code)
        for (const id of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)) {
          const file = path.join(root, id, "definition.json")
          const definition = wrapDefinitionStrings(JSON.parse(await readFile(file, "utf8")), "en")
          const written = await translateDefinition(model, definition, targets)
          await writeFile(file, JSON.stringify(definition, null, 2) + "\n")
          console.log(`${id}: ${written} translations written`)
        }
        return 0
      }
      case "serve": {
        // The area-of-interest shape is derived state; rebuilding it at boot
        // covers databases migrated before this release and bundled-boundary
        // updates alike. A missing boundary is logged, never fatal
        await refreshAoi(pool, await getDefaultAoi(pool)).catch(err =>
          console.warn(`Area of interest shape not rebuilt: ${err instanceof Error ? err.message : err}`)
        )
        const deps = buildDeps(pool, new Runner(), config)
        const tiles = new TileRenderer(deps.store, config.tileCachePath)
        const model = buildModel(config)
        const libraryPath = config.libraryPath
        const agent = model
          ? AgentService.forDesigner(pool, { ...deps, model, skillsDir: skillsDir(libraryPath), libraryPath })
          : null
        const dashboardAgent = model ? AgentService.forDashboard(pool, { pool, model, libraryPath }) : null
        const assistantAgent = model ? AgentService.forAssistant(pool, { pool, model, libraryPath }) : null
        const runService = new RunService(deps)
        const basemap = new BasemapProxy(basemapConfigFrom(config))
        // Cron scheduling and queue draining need the job runner; the API
        // itself (browse, query, design) stands without one
        try {
          await deps.runner.ensureReady()
          startScheduler(deps, { tiles, tileCacheMb: config.tileCacheMb })
          console.log("Scheduler running (cron enqueue, queue workers, stale-run reaper)")
        } catch (err) {
          console.log(`No job runner available; scheduler disabled (${err instanceof Error ? err.message : err})`)
        }
        createApiServer(
          pool,
          tiles,
          agent,
          runService,
          deps.store,
          dashboardAgent,
          basemap,
          config.uiDistPath,
          config.libraryPath,
          assistantAgent,
          aiProvider(config),
          config.viteDevUrl,
          model
        ).listen(
          config.port,
          () => {
            console.log(`Serving on http://127.0.0.1:${config.port} (${describeConfig(config)})`)
            if (config.viteDevUrl) {
              console.log(`UI hot-reloads from ${config.viteDevUrl}`)
            }
            if (!agent) console.log("No model configured; session API disabled")
          }
        )
        return await new Promise<number>(() => {})
      }
      default:
        console.error(
          "Usage: cli.js migrate | install <file|dir> | run <integrationId> | agent [integrationId|sessionId] | register-rasters | serve"
        )
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

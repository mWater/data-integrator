/**
 * Designer model evaluation: runs the standardized design prompts in
 * library/prompts/ against candidate models through the real designer loop,
 * sandbox and cold-run gate, with a simulated operator answering questions.
 * See eval/README.md. Usage:
 *
 *   pnpm eval:designer --model nvidia/nemotron-3.5-super-vl [--model ...]
 *     [--prompts ghsl_built_up,hydrosheds | all] [--repeats 1] [--effort medium]
 *     [--country MDG] [--out DIR] [--secrets eval/secrets.json]
 *     [--operator-model anthropic/claude-sonnet-5.5] [--judge-model ...] [--no-judge]
 *     [--max-tokens 15000000] [--max-minutes 120] [--max-load-minutes 60]
 *     [--max-operator-turns 12] [--job-dns 8.8.8.8,8.8.4.4] [--fresh-first-load] [--keep-db] [--keep-data]
 *
 * Every session gets its own throwaway PostGIS container and storage
 * directories, and a library holding only skills/ (the finished entries would
 * hand the designer the answer through search_library).
 */
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import { ModelMessage } from "ai"
import pg from "pg"
import { Runner } from "@mwater/integration-runner"
import { aiTokenBudget, saveAiLimits } from "../src/aiLimits.js"
import { buildModel } from "../src/aiSettings.js"
import { refreshAoi } from "../src/aoi.js"
import { AgentEffort, AppConfig, loadConfig } from "../src/config.js"
import { COUNTRIES } from "../src/countries.js"
import { createPool } from "../src/db.js"
import { ExecutorDeps } from "../src/executor.js"
import { FileStore } from "../src/fileStore.js"
import { migrate } from "../src/migrations.js"
import { RasterStore } from "../src/rasterStore.js"
import { SandboxBudget } from "../src/sandboxBudget.js"
import { setSecret } from "../src/secrets.js"
import { DEFAULT_AOI_KEY, DefaultAoi, LOCALES_KEY, setSetting } from "../src/settings.js"
import { skillsDir } from "../src/skills.js"
import { AgentSessionController, SessionStop } from "../src/agent/controller.js"
import { DesignerDeps, DesignerImplementation, DesignerState } from "../src/agent/designer.js"
import { definitionHash } from "../src/install.js"
import { scratchWorkDir } from "../src/scratch.js"
import { AgentService } from "../src/agent/service.js"
import { AgentEvent, AgentEventListener, ToolOutcome } from "../src/agent/types.js"
import { judge, JudgeResult } from "./judge.js"
import { Operator, OperatorTurn, Steer } from "./operator.js"
import { DesignPrompt, loadPrompts } from "./prompts.js"

const execFileP = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..", "..")
const MIGRATIONS_DIR = path.resolve(HERE, "..", "migrations")
const POSTGIS_IMAGE = "docker.io/postgis/postgis:16-3.4"

/** How a session ended. */
type Outcome =
  | "finished" // passed the cold-run gate and installed
  | "step_limit" // designer's 200-call cap
  | "token_cap" // --max-tokens reached
  | "time_limit" // --max-minutes reached
  | "operator_limit" // --max-operator-turns reached without finishing
  | "blocked_secret" // asked for a credential the secrets file lacks
  | "crashed" // model/provider error

/** One session's record, one line of results.jsonl. */
interface RunRecord {
  model: string
  prompt: string
  repeat: number
  outcome: Outcome
  error: string | null
  minutes: number
  steps: number
  inputTokens: number
  outputTokens: number
  /** Estimated from OpenRouter list prices; ignores cache discounts, so an upper bound */
  costUsd: number | null
  steers: Steer[]
  toolCalls: Record<string, number>
  toolErrors: number
  runs: { warm: number; cold: number; succeeded: number; failed: number }
  thrashPauses: number
  /** True when an operator reply came before the first edit_code/run_integration, as the system prompt requires; null if it never built */
  confirmedBeforeBuilding: boolean | null
  integrationId: string | null
  /** The production load finish started: succeeded, failed, timeout, or none */
  firstLoad: { status: string; error: string | null } | null
  outputs: { layers: unknown[]; tables: { id: string; rows: number }[] }
  judge: JudgeResult | null
  operatorTokens: number
  dir: string
}

/** Command-line options. */
interface Options {
  models: string[]
  prompts: string[] | "all"
  repeats: number
  effort: AgentEffort | null
  country: string
  out: string
  secrets: Record<string, string>
  operatorModel: string
  judgeModel: string
  judge: boolean
  maxTokens: number
  maxMinutes: number
  maxLoadMinutes: number
  maxOperatorTurns: number
  /** DNS servers for sandbox jobs; null keeps the runner's default (1.1.1.1, 9.9.9.9) */
  jobDns: string[] | null
  /** Let the first production load download everything again instead of reusing the cold run's /work */
  freshFirstLoad: boolean
  keepDb: boolean
  keepData: boolean
}

/** Parses argv into options; throws on bad input. */
async function parseOptions(): Promise<Options> {
  const { values } = parseArgs({
    options: {
      model: { type: "string", multiple: true },
      prompts: { type: "string", default: "all" },
      repeats: { type: "string", default: "1" },
      effort: { type: "string" },
      country: { type: "string", default: "MDG" },
      out: { type: "string" },
      secrets: { type: "string" },
      "operator-model": { type: "string", default: "anthropic/claude-sonnet-5.5" },
      "judge-model": { type: "string", default: "anthropic/claude-sonnet-5.5" },
      "no-judge": { type: "boolean", default: false },
      "max-tokens": { type: "string", default: "15000000" },
      "max-minutes": { type: "string", default: "120" },
      "max-load-minutes": { type: "string", default: "60" },
      "max-operator-turns": { type: "string", default: "12" },
      "job-dns": { type: "string" },
      "fresh-first-load": { type: "boolean", default: false },
      "keep-db": { type: "boolean", default: false },
      "keep-data": { type: "boolean", default: false }
    }
  })
  if (!values.model?.length) throw new Error("At least one --model is required (an OpenRouter model id)")
  const int = (name: string, raw: string): number => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
    return n
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return {
    models: values.model,
    prompts: values.prompts === "all" ? "all" : values.prompts!.split(",").map(s => s.trim()).filter(Boolean),
    repeats: int("repeats", values.repeats!),
    effort: (values.effort as AgentEffort | undefined) ?? null,
    country: values.country!.toUpperCase(),
    out: path.resolve(values.out ?? path.join(HERE, "results", stamp)),
    secrets: values.secrets ? JSON.parse(await readFile(values.secrets, "utf8")) : {},
    operatorModel: values["operator-model"]!,
    judgeModel: values["judge-model"]!,
    judge: !values["no-judge"],
    maxTokens: int("max-tokens", values["max-tokens"]!),
    maxMinutes: int("max-minutes", values["max-minutes"]!),
    maxLoadMinutes: int("max-load-minutes", values["max-load-minutes"]!),
    maxOperatorTurns: int("max-operator-turns", values["max-operator-turns"]!),
    freshFirstLoad: values["fresh-first-load"]!,
    jobDns: values["job-dns"] ? values["job-dns"].split(",").map(s => s.trim()).filter(Boolean) : null,
    keepDb: values["keep-db"]!,
    keepData: values["keep-data"]!
  }
}

/** A throwaway PostGIS container. */
interface EvalDb {
  url: string
  name: string
  stop: () => Promise<void>
}

/** Containers to remove if the process is interrupted. */
const liveContainers = new Set<string>()

/**
 * Starts a PostGIS container with the raster store mounted at its own path,
 * so out-db raster registration can open the snapshot files.
 */
async function startDb(rasterStore: string): Promise<EvalDb> {
  const name = `integrator-eval-${randomBytes(4).toString("hex")}`
  await execFileP("podman", [
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=eval",
    "-p", "127.0.0.1::5432",
    "-v", `${rasterStore}:${rasterStore}:ro`,
    POSTGIS_IMAGE
  ])
  liveContainers.add(name)
  const { stdout } = await execFileP("podman", ["port", name, "5432"])
  const url = `postgres://postgres:eval@127.0.0.1:${stdout.trim().split(":").pop()}/postgres`
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query("SELECT 1")
      await client.end()
      break
    } catch {
      if (Date.now() > deadline) throw new Error("Eval Postgres did not become ready in 90s")
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  return {
    url,
    name,
    stop: async () => {
      await execFileP("podman", ["rm", "-f", "-v", name]).catch(() => {})
      liveContainers.delete(name)
    }
  }
}

/** Executor dependencies, as cli.ts builds them. */
function buildDeps(pool: pg.Pool, runner: Runner, config: AppConfig): ExecutorDeps {
  return {
    pool,
    runner,
    databaseUrl: config.databaseUrl,
    store: new RasterStore(config.rasterStorePath),
    workRoot: config.workRoot,
    files: new FileStore(config.fileStorePath),
    secretKey: config.secretKey,
    images: { python: config.runtimeImages.python, node: config.runtimeImages.node },
    workQuotaMb: config.workQuotaMb,
    tmpQuotaMb: config.tmpQuotaMb,
    minFreeDiskMb: config.minFreeDiskMb,
    jobMax: { cpus: config.jobMax.cpus, memoryMb: config.jobMax.memoryMb, timeoutMs: config.jobMax.timeoutMin * 60_000 },
    sandboxes: config.sandboxMemoryMb > 0 ? new SandboxBudget(config.sandboxMemoryMb) : undefined
  }
}

/**
 * The designer, plus one eval-only shortcut: just before a finish that will be
 * accepted, the cold run's /work is copied to the installed integration's
 * /work, so the first production load reads the cold run's downloads (as a
 * warm run would) instead of fetching everything again. Only code that caches
 * in /work benefits; everything the model is measured on is unchanged.
 */
class EvalDesigner extends DesignerImplementation {
  private workRoot: string

  constructor(deps: DesignerDeps, workRoot: string) {
    super(deps)
    this.workRoot = workRoot
  }

  override async execute(
    name: string,
    input: unknown,
    state: DesignerState,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const id = state.definition.id
    if (name === "finish" && id && state.coldRun?.definitionHash === definitionHash(state.definition)) {
      const target = path.join(this.workRoot, id)
      // Files the sandbox wrote belong to subuids; copy inside podman's user namespace
      await execFileP("podman", ["unshare", "rm", "-rf", target])
      await execFileP("podman", ["unshare", "cp", "-a", scratchWorkDir(this.workRoot, sessionId), target]).catch(() => {})
    }
    return super.execute(name, input, state, events, sessionId)
  }
}

/** Removes a directory, falling back to podman unshare for files the sandbox wrote as subuids. */
async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() =>
    execFileP("podman", ["unshare", "rm", "-rf", dir]).catch(() => {})
  )
}

/** OpenRouter list prices per token, by model id. */
async function fetchPrices(): Promise<Map<string, { prompt: number; completion: number }>> {
  const prices = new Map<string, { prompt: number; completion: number }>()
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models")
    const body = (await response.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] }
    for (const m of body.data) {
      prices.set(m.id, { prompt: Number(m.pricing?.prompt ?? NaN), completion: Number(m.pricing?.completion ?? NaN) })
    }
  } catch {
    // Costs are reported as null
  }
  return prices
}

type Part = { type?: string; text?: string; toolName?: string; input?: unknown; output?: { value?: unknown } }

/** Content parts of a message ([] for plain string content). */
function partsOf(message: ModelMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : []
}

/** Text of a tool result part. */
function resultText(part: Part): string {
  const value = part.output?.value
  return typeof value === "string" ? value : JSON.stringify(value ?? "")
}

/** What the session paused on: everything since the last user message. */
function pauseOf(messages: ModelMessage[]): OperatorTurn & { secretsRequested: string[] } {
  const texts: string[] = []
  let question: string | null = null
  let options: string[] = []
  let lastToolResult: string | null = null
  let secretsRequested: string[] = []
  let start = messages.length
  while (start > 0 && messages[start - 1].role !== "user") start--
  for (const message of messages.slice(start)) {
    if (message.role === "assistant") {
      if (typeof message.content === "string") texts.push(message.content)
      for (const part of partsOf(message)) {
        if (part.type === "text" && part.text) texts.push(part.text)
        if (part.type === "tool-call" && part.toolName === "ask_user") {
          const input = part.input as { question?: string; options?: string[] }
          question = input.question ?? ""
          options = input.options ?? []
        }
      }
    } else if (message.role === "tool") {
      for (const part of partsOf(message)) {
        lastToolResult = resultText(part)
        const requested = lastToolResult.match(/^Credentials requested: ([^.]+)\./)
        if (part.toolName === "request_secrets" && requested) secretsRequested = requested[1].split(",").map(s => s.trim())
      }
    }
  }
  return { text: texts.join("\n\n").trim(), question, options, lastToolResult, secretsRequested }
}

/** The scripted reply to a credentials request; not an operator decision. */
const SECRETS_SAVED_REPLY = "I've saved the credentials in the form."

/** Tool-use statistics over a transcript. */
function toolStats(
  messages: ModelMessage[]
): Pick<RunRecord, "toolCalls" | "toolErrors" | "runs" | "thrashPauses" | "confirmedBeforeBuilding"> {
  const toolCalls: Record<string, number> = {}
  const runs = { warm: 0, cold: 0, succeeded: 0, failed: 0 }
  let toolErrors = 0
  let thrashPauses = 0
  // The system prompt requires the operator to confirm the plan before any
  // edit_code or run_integration: has an operator reply (beyond the request
  // itself) landed before the first of those?
  let operatorReplies = 0
  let confirmedBeforeBuilding: boolean | null = null
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" && index > 0 && message.content !== SECRETS_SAVED_REPLY) operatorReplies++
    for (const part of partsOf(message)) {
      if (
        confirmedBeforeBuilding === null &&
        part.type === "tool-call" &&
        (part.toolName === "edit_code" || part.toolName === "run_integration")
      ) {
        confirmedBeforeBuilding = operatorReplies > 0
      }
      if (part.type === "tool-call" && part.toolName) toolCalls[part.toolName] = (toolCalls[part.toolName] ?? 0) + 1
      if (part.type !== "tool-result") continue
      const text = resultText(part)
      if (/^(Error|Tool error|Rejected|Query error|Unknown tool)/.test(text)) toolErrors++
      if (/session is now paused for user guidance/.test(text)) thrashPauses++
      const run = text.match(/^(Cold|Warm) run (\w+)\./)
      if (run) {
        runs[run[1] === "Cold" ? "cold" : "warm"]++
        runs[run[2] === "succeeded" ? "succeeded" : "failed"]++
      }
    }
  }
  return { toolCalls, toolErrors, runs, thrashPauses, confirmedBeforeBuilding }
}

/** Readable transcript of a session for reviewers. */
function transcriptMarkdown(prompt: DesignPrompt, model: string, messages: ModelMessage[]): string {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more chars]` : s)
  const lines = [`# ${prompt.id} — ${model}`, ""]
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`## Operator\n\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}\n`)
    } else if (message.role === "assistant") {
      if (typeof message.content === "string") lines.push(`## Designer\n\n${message.content}\n`)
      for (const part of partsOf(message)) {
        if (part.type === "text" && part.text) lines.push(`## Designer\n\n${part.text}\n`)
        if (part.type === "tool-call") {
          lines.push(`**→ ${part.toolName}**\n\n\`\`\`json\n${clip(JSON.stringify(part.input, null, 2), 6000)}\n\`\`\`\n`)
        }
      }
    } else if (message.role === "tool") {
      for (const part of partsOf(message)) {
        lines.push(`**← ${part.toolName}**\n\n\`\`\`\n${clip(resultText(part), 3000)}\n\`\`\`\n`)
      }
    }
  }
  return lines.join("\n")
}

/** Layers and tables the installed integration produced. */
async function outputsOf(pool: pg.Pool, integrationId: string): Promise<RunRecord["outputs"]> {
  const layers = await pool.query(
    `SELECT l.id, l.name->>'_base' AS base, l.name, l.temporality, count(s.id)::int AS snapshots,
            min(s.observed_at) AS first, max(s.observed_at) AS last, sum(s.size_bytes)::bigint AS bytes
     FROM app.raster_layers l LEFT JOIN app.raster_snapshots s ON s.layer_id = l.id AND s.status = 'promoted'
     WHERE l.integration_id = $1 GROUP BY l.id ORDER BY l.id`,
    [integrationId]
  )
  const tables: { id: string; rows: number }[] = []
  for (const row of (await pool.query("SELECT id FROM app.data_tables WHERE integration_id = $1 ORDER BY id", [integrationId])).rows) {
    const count = await pool.query(`SELECT count(*)::int AS n FROM data."${String(row.id).replace(/"/g, '""')}"`).catch(() => null)
    tables.push({ id: row.id, rows: count?.rows[0].n ?? -1 })
  }
  return { layers: layers.rows, tables }
}

/** Waits for the production load finish started; null when there was none. */
async function waitForFirstLoad(pool: pg.Pool, integrationId: string, minutes: number): Promise<RunRecord["firstLoad"]> {
  const deadline = Date.now() + minutes * 60_000
  for (;;) {
    const result = await pool.query(
      "SELECT status, error FROM app.runs WHERE integration_id = $1 AND session_id IS NULL ORDER BY scheduled_at DESC LIMIT 1",
      [integrationId]
    )
    if (result.rows.length === 0) return null
    const { status, error } = result.rows[0]
    if (status !== "queued" && status !== "running") return { status, error: error ? String(error).split("\n")[0].slice(0, 500) : null }
    if (Date.now() > deadline) return { status: "timeout", error: `still ${status} after ${minutes} min` }
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
}

/** Runs one prompt against one model in a fresh deployment and records the outcome. */
async function runOne(
  options: Options,
  apiKey: string,
  libraryDir: string,
  aoi: DefaultAoi,
  prices: Map<string, { prompt: number; completion: number }>,
  modelId: string,
  prompt: DesignPrompt,
  repeat: number
): Promise<RunRecord> {
  const dir = path.join(options.out, `${modelId.replace(/[^\w.-]+/g, "_")}__${prompt.id}__r${repeat}`)
  const storage = { raster: path.join(dir, "raster-store"), work: path.join(dir, "work"), files: path.join(dir, "file-store") }
  for (const d of Object.values(storage)) await mkdir(d, { recursive: true })
  const eventsLog = path.join(dir, "events.log")
  const log = (line: string): Promise<void> => appendFile(eventsLog, line + "\n")
  const started = Date.now()
  const db = await startDb(storage.raster)
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: db.url,
    RASTER_STORE_PATH: storage.raster,
    WORK_ROOT: storage.work,
    FILE_STORE_PATH: storage.files,
    LIBRARY_PATH: libraryDir,
    INTEGRATOR_SECRET_KEY: process.env.INTEGRATOR_SECRET_KEY || randomBytes(32).toString("base64")
  })
  const pool = createPool(config.databaseUrl)
  const record: RunRecord = {
    model: modelId,
    prompt: prompt.id,
    repeat,
    outcome: "crashed",
    error: null,
    minutes: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    steers: [],
    toolCalls: {},
    toolErrors: 0,
    runs: { warm: 0, cold: 0, succeeded: 0, failed: 0 },
    thrashPauses: 0,
    confirmedBeforeBuilding: null,
    integrationId: null,
    firstLoad: null,
    outputs: { layers: [], tables: [] },
    judge: null,
    operatorTokens: 0,
    dir
  }
  const operator = new Operator(buildModel({ provider: "openrouter", model: options.operatorModel, baseUrl: null, apiKey }, null), prompt)
  try {
    await migrate(pool, MIGRATIONS_DIR)
    await setSetting(pool, DEFAULT_AOI_KEY, aoi)
    await refreshAoi(pool, aoi)
    // English only: finish translates catalog text into every locale with the candidate model
    await setSetting(pool, LOCALES_KEY, ["en"])
    // The deployment is this session alone, so its daily cap is the session's token cap
    await saveAiLimits(pool, { userDailyTokens: null, deploymentDailyTokens: options.maxTokens })

    const model = buildModel({ provider: "openrouter", model: modelId, baseUrl: null, apiKey }, options.effort)
    const runner = new Runner({ blockedAddresses: config.jobBlockedAddresses, ...(options.jobDns ? { dns: options.jobDns } : {}) })
    await runner.ensureReady()
    const deps = { ...buildDeps(pool, runner, config), model, skillsDir: skillsDir(libraryDir), libraryPath: libraryDir }
    const controller = new AgentSessionController(
      pool,
      options.freshFirstLoad ? new DesignerImplementation(deps) : new EvalDesigner(deps, config.workRoot),
      aiTokenBudget(pool)
    )
    const designer = AgentService.forDesigner(pool, deps)
    const sessionId = await designer.createSession()
    await log(`session ${sessionId}`)

    const deadline = started + options.maxMinutes * 60_000
    const onEvent = (event: AgentEvent): void => {
      const line =
        event.type === "assistant_text" ? `TEXT ${event.text.replace(/\n/g, " ").slice(0, 400)}`
        : event.type === "tool_start" ? `CALL ${event.tool} ${(JSON.stringify(event.input) ?? "").slice(0, 300)}`
        : event.type === "tool_end" ? `DONE ${event.tool} ${event.summary.split("\n")[0]}`
        : event.type === "job_log" ? `  | ${event.line}`
        : `BOUND ${event.integrationId}`
      void log(`${new Date().toISOString().slice(11, 19)} ${line}`)
    }

    let text = prompt.prompt
    for (;;) {
      let stop: SessionStop
      try {
        stop = await controller.sendMessage(sessionId, text, onEvent, { stopRequested: () => Date.now() > deadline })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        record.outcome = /daily AI allowance/.test(message) ? "token_cap" : "crashed"
        record.error = message.slice(0, 1000)
        break
      }
      if (stop.reason === "finished") {
        record.outcome = "finished"
        break
      }
      if (stop.reason === "step_limit") {
        record.outcome = "step_limit"
        break
      }
      if (stop.reason === "stopped") {
        record.outcome = "time_limit"
        break
      }
      const detail = await designer.getSession(sessionId)
      const pause = pauseOf(detail!.messages as ModelMessage[])
      if (pause.secretsRequested.length > 0) {
        const missing = pause.secretsRequested.filter(name => !(name in options.secrets))
        if (missing.length > 0) {
          record.outcome = "blocked_secret"
          record.error = `No value in --secrets for: ${missing.join(", ")}`
          break
        }
        for (const name of pause.secretsRequested) {
          await setSecret(pool, config.secretKey!, detail!.integrationId!, name, options.secrets[name])
        }
        text = SECRETS_SAVED_REPLY
        operator.record(`request_secrets: ${pause.secretsRequested.join(", ")}`, text)
        await log(`OPERATOR (scripted) ${text}`)
        continue
      }
      if (operator.steers.length >= options.maxOperatorTurns) {
        record.outcome = "operator_limit"
        break
      }
      text = await operator.reply(pause)
      await log(`OPERATOR ${text.replace(/\n/g, " ")}`)
    }

    const detail = await designer.getSession(sessionId)
    const messages = (detail?.messages ?? []) as ModelMessage[]
    const usage = (detail?.usage ?? {}) as { steps?: number; inputTokens?: number; outputTokens?: number }
    record.steps = usage.steps ?? 0
    record.inputTokens = usage.inputTokens ?? 0
    record.outputTokens = usage.outputTokens ?? 0
    const price = prices.get(modelId)
    if (price && Number.isFinite(price.prompt) && Number.isFinite(price.completion)) {
      record.costUsd = Math.round((record.inputTokens * price.prompt + record.outputTokens * price.completion) * 100) / 100
    }
    Object.assign(record, toolStats(messages))
    record.integrationId = detail?.integrationId ?? null
    await writeFile(path.join(dir, "transcript.md"), transcriptMarkdown(prompt, modelId, messages))
    await writeFile(path.join(dir, "session.json"), JSON.stringify({ messages, state: detail?.state, usage }, null, 1))

    if (record.outcome === "finished" && record.integrationId) {
      record.firstLoad = await waitForFirstLoad(pool, record.integrationId, options.maxLoadMinutes)
      record.outputs = await outputsOf(pool, record.integrationId)
      const installed = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [record.integrationId])
      const definition = installed.rows[0]?.definition as { code?: string; runtime?: string } | undefined
      if (definition) {
        const { code, ...rest } = definition
        await writeFile(path.join(dir, "definition.json"), JSON.stringify(rest, null, 2))
        await writeFile(path.join(dir, definition.runtime === "node" ? "code.mjs" : "code.py"), code ?? "")
      }
      if (options.judge && record.firstLoad?.status === "succeeded") {
        const context = [
          `First production load: ${record.firstLoad.status}`,
          `Outputs: ${JSON.stringify(record.outputs)}`,
          `Definition (code omitted): ${JSON.stringify({ ...definition, code: undefined }).slice(0, 20000)}`,
          `Code:\n${(definition?.code ?? "").slice(0, 30000)}`
        ].join("\n\n")
        const judgeModel = buildModel({ provider: "openrouter", model: options.judgeModel, baseUrl: null, apiKey }, null)
        record.judge = await judge(judgeModel, pool, prompt, record.integrationId, context).catch(err => ({
          checks: [],
          overall: "partial" as const,
          notes: `Judge failed: ${err instanceof Error ? err.message : String(err)}`,
          tokens: 0
        }))
      }
    }
  } catch (err) {
    record.outcome = "crashed"
    record.error = (err instanceof Error ? err.stack ?? err.message : String(err)).slice(0, 2000)
  } finally {
    record.steers = operator.steers
    record.operatorTokens = operator.tokens
    record.minutes = Math.round((Date.now() - started) / 6000) / 10
    await writeFile(path.join(dir, "result.json"), JSON.stringify(record, null, 2))
    await pool.end().catch(() => {})
    if (options.keepDb) {
      liveContainers.delete(db.name)
      await log(`kept database ${db.name}: ${db.url}`)
    } else {
      await db.stop()
    }
    if (!options.keepData) for (const d of Object.values(storage)) await removeDir(d)
  }
  return record
}

/** Median of numbers; null for none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Markdown summary of every record so far: per-run rows and per-model totals. */
function summaryMarkdown(records: RunRecord[], options: Options): string {
  const lines = [
    "# Designer evaluation",
    "",
    `Operator: ${options.operatorModel}. Judge: ${options.judge ? options.judgeModel : "off"}. AOI: ${options.country}. Effort: ${options.effort ?? "model default"}.`,
    "Cost is estimated from OpenRouter list prices and ignores prompt-cache discounts.",
    "",
    "## By model",
    "",
    "| Model | Runs | Finished | First load OK | Judge pass | Plan confirmed | Median steps | Median steers | Median $ | Median min |",
    "|---|---|---|---|---|---|---|---|---|---|"
  ]
  for (const model of [...new Set(records.map(r => r.model))]) {
    const rs = records.filter(r => r.model === model)
    const count = (f: (r: RunRecord) => boolean): string => `${rs.filter(f).length}/${rs.length}`
    const med = (f: (r: RunRecord) => number | null): string => String(median(rs.map(f).filter((v): v is number => v !== null)) ?? "–")
    lines.push(
      `| ${model} | ${rs.length} | ${count(r => r.outcome === "finished")} | ${count(r => r.firstLoad?.status === "succeeded")} | ${count(r => r.judge?.overall === "pass")} | ${count(r => r.confirmedBeforeBuilding === true)} | ${med(r => r.steps)} | ${med(r => r.steers.length)} | ${med(r => r.costUsd)} | ${med(r => r.minutes)} |`
    )
  }
  lines.push(
    "",
    "## Runs",
    "",
    "| Model | Prompt | # | Outcome | First load | Judge | Plan confirmed | Steps | Tokens in/out | $ | Steers | Tool errors | Runs ok/fail | Min |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  )
  for (const r of records) {
    const judgeCell = r.judge
      ? `${r.judge.overall} (${r.judge.checks.filter(c => c.verdict === "pass").length}/${r.judge.checks.length})`
      : "–"
    lines.push(
      `| ${r.model} | ${r.prompt} | ${r.repeat} | ${r.outcome} | ${r.firstLoad?.status ?? "–"} | ${judgeCell} | ${r.confirmedBeforeBuilding === null ? "–" : r.confirmedBeforeBuilding ? "yes" : "**no**"} | ${r.steps} | ${(r.inputTokens / 1e6).toFixed(2)}M/${(r.outputTokens / 1e3).toFixed(0)}k | ${r.costUsd ?? "–"} | ${r.steers.length} | ${r.toolErrors} | ${r.runs.succeeded}/${r.runs.failed} | ${r.minutes} |`
    )
  }
  const notes = records.filter(r => r.error || r.firstLoad?.error)
  if (notes.length) {
    lines.push("", "## Errors", "")
    for (const r of notes) lines.push(`- ${r.model} / ${r.prompt} #${r.repeat}: ${(r.error ?? r.firstLoad?.error ?? "").split("\n")[0]}`)
  }
  return lines.join("\n") + "\n"
}

async function main(): Promise<number> {
  const options = await parseOptions()
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (put it in the repository's .env)")
  const country = COUNTRIES.find(c => c.iso3 === options.country)
  if (!country) throw new Error(`Unknown country ${options.country}`)
  const aoi: DefaultAoi = { bbox: country.bbox, countries: [country.iso3], name: country.name }
  const prompts = await loadPrompts(path.join(REPO, "library", "prompts"), options.prompts)

  // Skills only: an empty integrations/ keeps search_library from handing over the finished entries
  const libraryDir = path.join(options.out, "library")
  await mkdir(path.join(libraryDir, "integrations"), { recursive: true })
  await symlink(path.join(REPO, "library", "skills"), path.join(libraryDir, "skills")).catch(() => {})

  const prices = await fetchPrices()
  for (const id of [...options.models, options.operatorModel, ...(options.judge ? [options.judgeModel] : [])]) {
    if (prices.size > 0 && !prices.has(id)) throw new Error(`OpenRouter has no model ${id}`)
  }
  await writeFile(path.join(options.out, "options.json"), JSON.stringify({ ...options, secrets: Object.keys(options.secrets) }, null, 2))

  const interrupt = async (): Promise<void> => {
    for (const name of liveContainers) await execFileP("podman", ["rm", "-f", "-v", name]).catch(() => {})
    process.exit(130)
  }
  process.once("SIGINT", () => void interrupt())
  process.once("SIGTERM", () => void interrupt())

  const records: RunRecord[] = []
  const total = options.models.length * prompts.length * options.repeats
  for (const prompt of prompts) {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const model of options.models) {
        console.log(`[${records.length + 1}/${total}] ${model} · ${prompt.id} · #${repeat}`)
        const record = await runOne(options, apiKey, libraryDir, aoi, prices, model, prompt, repeat)
        records.push(record)
        console.log(
          `  ${record.outcome}${record.firstLoad ? `, first load ${record.firstLoad.status}` : ""}${record.judge ? `, judge ${record.judge.overall}` : ""}` +
            ` · ${record.steps} steps · ${record.steers.length} steers · $${record.costUsd ?? "?"} · ${record.minutes} min`
        )
        await appendFile(path.join(options.out, "results.jsonl"), JSON.stringify(record) + "\n")
        await writeFile(path.join(options.out, "summary.md"), summaryMarkdown(records, options))
      }
    }
  }
  console.log(`\nSummary: ${path.join(options.out, "summary.md")}`)
  return 0
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
)

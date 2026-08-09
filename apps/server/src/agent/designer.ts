import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LanguageModel, ToolSet, tool } from "ai"
import { z } from "zod"
import { IntegrationDefinition, RuntimeId } from "@data-integrator/definitions"
import { AgentEventListener, AgentImplementation, ToolOutcome } from "./types.js"
import { ExecutorDeps, executeRun } from "../executor.js"
import { ID_PATTERN, definitionHash, installIntegration, validateDefinition } from "../install.js"
import { materializeInputs } from "../materialize.js"
import { cleanupScratch, draftSchema, scratchWorkDir } from "../scratch.js"
import { getSecrets } from "../secrets.js"

/** Client state of a designer session: the draft and its certification. */
export interface DesignerState {
  /** Draft integration definition being designed */
  definition: IntegrationDefinition
  /** Successful cold run certifying a definition hash, if any */
  coldRun: { definitionHash: string; runId: string } | null
  /** Most recent test run, for status display */
  lastRun: { runId: string; status: string; cold: boolean } | null
  /** Consecutive failed runs sharing one error signature (thrash guard); absent on older sessions */
  failStreak?: { signature: string; count: number } | null
}

/** Everything the designer needs: executor deps plus the model. */
export interface DesignerDeps extends ExecutorDeps {
  /** Language model for the session loop */
  model: LanguageModel
}

/** Snippet resource limits: exploration jobs stay small and short. */
const SNIPPET_LIMITS = { cpus: 2, memoryMb: 2048, timeoutMs: 180_000 }

/**
 * Fresh draft state for a new designer session. With no integrationId the
 * draft starts unbound (empty id) and the agent names it on the first
 * write_definition.
 */
export function initialDesignerState(integrationId = ""): DesignerState {
  return {
    definition: {
      id: integrationId,
      name: integrationId,
      trigger: {},
      runtime: "python3.12",
      destinations: [],
      code: "",
      contract: 2
    },
    coldRun: null,
    lastRun: null,
    failStreak: null
  }
}

/** Failed runs count as "the same" when their errors match after path noise is stripped. */
export function errorSignature(error: string): string {
  return error.replace(/\/tmp\/[A-Za-z0-9_-]+/g, "/tmp/*").slice(0, 300)
}

/** Identical failures before the agent is told to stop and ask the user. */
const FAIL_STREAK_WARN = 3

/** Identical failures before the session is force-paused. */
const FAIL_STREAK_PAUSE = 5

/** System prompt: definition format, code contract, and the design workflow. */
const SYSTEM = `You are the integration designer for the Data Integrator platform. You design and
repair one integration per session: a JSON definition plus one self-contained code file
that ingests external data into Postgres tables and/or the raster catalog.

# Definition format (contract 2)
Fields: id (snake_case; immutable once set), name, description?, source? {name, url?, provider?,
license?, documentation?}, trigger ({cron: "..."} and/or {webhook: true}, or {} for
manual only), secrets? [names only], aoi? {bbox: [west, south, east, north], countries?: [ISO3...]}
(omit aoi to inherit the deployment default at run time),
runtime ("python3.12" | "node22"), limits? {timeoutMs?, memoryMb?, cpus?},
destinations [below], validation?, code (via edit_code, not write_definition), contract: 2.

Destinations:
- {kind: "table", tableId, action: "replace"|"append"|"merge", mergeColumns?
  [required for merge, must name declared columns], columns: [{id, name?, type: "text"|
  "number"|"integer"|"boolean"|"date"|"datetime"|"geometry"|"enum"|"json",
  enumValues? [{id, name}] when type is "enum", units?}]}
- {kind: "raster", layerId, name?, temporality: "time-series"|"current-only", bands:
  [{id, name?, units?, rendering? {resampling: "nearest"|"average", defaultRange?
  {min, max}, colorMap? [{value, color: "#rrggbb" or "#rrggbbaa"}]}}]}

# Code contract
One file, entrypoint run(ctx).
Python: def run(ctx); ctx.definition, ctx.secrets, ctx.previous_state, ctx.webhook_data,
ctx.params, ctx.in_dir, ctx.work_dir, ctx.out_dir.
Node: export default async function run({definition, secrets, previousState, webhookData,
params, inDir, workDir, outDir}).
Return: {data?: {tableId: [row objects matching declared columns]}, rasters?: [{layerId,
path (relative to /out, e.g. "pop_2023.tif"), timestamp, timestampEnd?, footprint?
[w,s,e,n], crs?, metadata?}], state?: any}. Geometry columns take GeoJSON; raster files should be COGs.
/work persists between runs of this integration; treat it as a cache, never as the source
of truth. previousState is the state returned by the last successful run (null on the
first run); use it for incremental ingestion. print/console.log output goes to the run log.

Python image: gdal CLI tools, rasterio, geopandas, pandas, numpy, xarray, cfgrib, pyproj,
requests. Node image: csv-parse, fast-xml-parser, date-fns. Jobs have public-internet
egress only; private networks are blocked.

# Inputs (derived integrations)
An integration can consume platform data instead of (or as well as) external
sources. Declare inputs keyed by an input id:
- {kind: "raster", layerId, select: "current" | {latest: N} | {from: iso, to?: iso}}
- {kind: "table", tableId, columns?, where? [{column, op: "="|"!="|">"|">="|"<"|"<="|"in",
  value}], format? "gpkg"|"json"|"csv" (default gpkg on python, json on node)}
The server materializes them under /in before each run and snippet: raster
snapshots as /in/<inputId>/<timestamp>.tif, table extracts as /in/<inputId>.<ext>,
described by /in/manifest.json (paths, snapshot ids, timestamps, band order, row
counts). Read the manifest rather than guessing paths. Inputs must not reference
this integration's own destinations.

# Workflow
0. If the draft id is empty, choose one (short snake_case derived from the request)
   and save an initial definition with write_definition before anything else; the
   sandbox tools are rejected until the draft has an id.
1. Explore candidate sources with run_snippet (network is live; print what you learn).
2. Propose a plan and wait for confirmation - always, even when the request seems
   fully specified: in plain text, tell the user the data source you chose (name
   and URL), what will be ingested at what cadence, the destination tables/layers,
   key assumptions, and any open questions - then call ask_user to confirm (e.g.
   "Proceed as planned" plus meaningful alternatives). Never call edit_code or
   run_integration before the user has answered; re-confirm whenever you later
   change source or scope.
3. write_definition for everything except code; edit_code for the code.
4. Iterate with run_integration (warm: /work cache makes retries fast). Test runs
   write to a session-scoped scratch area; nothing touches installed integrations
   or their data until finish. query_table reads your scratch tables by plain name.
5. When it works, run_integration with cold=true (fresh /work, null previousState).
6. finish saves: it installs the certified definition as the real integration and
   discards the scratch area (the first production run then loads data). It is
   rejected unless the current code passed a cold run unchanged.

Rules: never fabricate data. Reference secrets by name only. Prefer incremental state
over re-downloading. Whenever a choice is not forced (dataset variant, resolution,
year, aggregation), ask_user rather than guessing. Plain text with no tool calls also
pauses the session, for open-ended questions. Your plain text renders as markdown.`

/**
 * The designer agent: tools to explore a source, shape the draft definition,
 * test it through the real executor, and finish behind the cold-run gate.
 */
export class DesignerImplementation implements AgentImplementation<DesignerState> {
  /** Session kind for storage */
  readonly kind = "designer" as const
  /** Language model for the loop */
  readonly model: LanguageModel
  /** Hard cap on model calls per session */
  readonly maxSteps = 200

  private deps: DesignerDeps

  /** Creates the implementation over executor deps plus a model. */
  constructor(deps: DesignerDeps) {
    this.deps = deps
    this.model = deps.model
  }

  /** System prompt (state-independent; authoritative state travels as tool results). */
  system(): string {
    return SYSTEM
  }

  /** Tool schemas; execution is in execute(). */
  tools(): ToolSet {
    return {
      get_definition: tool({
        description: "Read the current draft definition. Code is elided unless includeCode is true.",
        inputSchema: z.object({
          includeCode: z.boolean().optional().describe("Include the full code text")
        })
      }),
      write_definition: tool({
        description:
          "Replace the draft definition with the given JSON. The code field is preserved from the current draft; use edit_code for code. When the draft has no id yet, the incoming id names the integration; after that the id cannot change.",
        inputSchema: z.object({
          definitionJson: z.string().describe("Complete definition as JSON text")
        })
      }),
      edit_code: tool({
        description:
          "Edit the integration code by exact-string replacement. oldString must occur exactly once. Pass an empty oldString only when the code is still empty (sets the whole file).",
        inputSchema: z.object({
          oldString: z.string().describe("Exact text to replace; empty only for initially empty code"),
          newString: z.string().describe("Replacement text")
        })
      }),
      run_snippet: tool({
        description:
          "Run a throwaway code snippet in the sandbox (same ctx, /work and network as a real run; nothing is committed). Python snippets print to stdout; keep them self-contained.",
        inputSchema: z.object({
          code: z.string().describe("Snippet source"),
          runtime: z.enum(["python3.12", "node22"]).optional().describe("Defaults to the draft's runtime")
        })
      }),
      run_integration: tool({
        description:
          "Execute a real run of the draft through the executor, into this session's scratch area (scratch tables and preview layers; installed integrations are untouched). cold=true wipes /work and nulls previousState; a successful cold run certifies the current definition for finish.",
        inputSchema: z.object({
          cold: z.boolean().describe("Fresh workspace certification run")
        })
      }),
      query_table: tool({
        description: "Run one read-only SELECT against the data schema (destination tables). Returns up to 50 rows as JSON.",
        inputSchema: z.object({
          sql: z.string().describe("A single SELECT (or WITH...SELECT) statement")
        })
      }),
      ask_user: tool({
        description:
          "Ask the user a question with selectable options and pause until they answer. Use it to confirm the plan and for any unforced choice (source, dataset variant, resolution, cadence). The user may also reply free-form.",
        inputSchema: z.object({
          question: z.string().describe("The question, markdown allowed; include the context needed to choose"),
          options: z.array(z.string()).min(2).max(5).describe("Short answer choices (2-5)")
        })
      }),
      finish: tool({
        description:
          "Save and end the session: installs the certified definition as the real integration and discards the scratch area. Rejected unless the current definition passed a cold run unchanged.",
        inputSchema: z.object({
          summary: z.string().describe("One-paragraph summary of what was built")
        })
      })
    }
  }

  /** Executes one tool call. */
  async execute(
    name: string,
    input: unknown,
    state: DesignerState,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const args = (input ?? {}) as Record<string, unknown>
    switch (name) {
      case "get_definition":
        return this.getDefinition(state, args.includeCode === true)
      case "write_definition":
        return await this.writeDefinition(state, String(args.definitionJson ?? ""), events)
      case "edit_code":
        return this.editCode(state, String(args.oldString ?? ""), String(args.newString ?? ""))
      case "run_snippet":
        return await this.runSnippet(state, String(args.code ?? ""), args.runtime as RuntimeId | undefined, events, sessionId)
      case "run_integration":
        return await this.runIntegration(state, args.cold === true, events, sessionId)
      case "query_table":
        return await this.queryTable(String(args.sql ?? ""), sessionId)
      case "ask_user":
        return this.askUser(args)
      case "finish":
        return await this.finish(state, String(args.summary ?? ""), sessionId)
      default:
        return { result: `Unknown tool ${name}` }
    }
  }

  /** Returns the draft as JSON, eliding code by default. */
  private getDefinition(state: DesignerState, includeCode: boolean): ToolOutcome<DesignerState> {
    const definition = includeCode
      ? state.definition
      : { ...state.definition, code: `<${state.definition.code.length} chars, pass includeCode: true>` }
    return { result: JSON.stringify(definition, null, 2) }
  }

  /**
   * Replaces the draft (code preserved); reports validation problems. An
   * unbound draft takes its id from the incoming definition (checked against
   * installed integrations); a bound draft keeps its id.
   */
  private async writeDefinition(
    state: DesignerState,
    definitionJson: string,
    events: AgentEventListener
  ): Promise<ToolOutcome<DesignerState>> {
    let incoming: IntegrationDefinition
    try {
      incoming = JSON.parse(definitionJson)
    } catch (err) {
      return { result: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
    }
    let id = state.definition.id
    if (id === "") {
      id = String(incoming.id ?? "")
      if (!ID_PATTERN.test(id)) {
        return { result: `Invalid integration id "${id}": lowercase snake_case starting with a letter` }
      }
      const taken = await this.deps.pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [id])
      if (taken.rows.length > 0) {
        return { result: `Integration id "${id}" is already installed; choose a different id` }
      }
      events({ type: "integration_bound", integrationId: id })
    }
    const definition = { ...incoming, id, code: state.definition.code }
    let validation = "valid"
    try {
      validateDefinition(definition)
    } catch (err) {
      validation = `INVALID: ${err instanceof Error ? err.message : String(err)}`
    }
    return { result: `Draft saved. Validation: ${validation}`, state: { ...state, definition } }
  }

  /** Exact-string code edit; the empty oldString only initializes empty code. */
  private editCode(state: DesignerState, oldString: string, newString: string): ToolOutcome<DesignerState> {
    const code = state.definition.code
    let next: string
    if (oldString === "") {
      if (code !== "") return { result: "Error: oldString is required when code is not empty" }
      next = newString
    } else {
      const count = code.split(oldString).length - 1
      if (count === 0) return { result: "Error: oldString not found in code" }
      if (count > 1) return { result: `Error: oldString occurs ${count} times; provide a longer unique string` }
      next = code.replace(oldString, newString)
    }
    return {
      result: `Code updated (${next.length} chars)`,
      state: { ...state, definition: { ...state.definition, code: next } }
    }
  }

  /** Runs a scratch snippet in the sandbox against the draft's context. */
  private async runSnippet(
    state: DesignerState,
    code: string,
    runtime: RuntimeId | undefined,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const effectiveRuntime = runtime ?? state.definition.runtime
    const image = this.deps.images[effectiveRuntime]
    if (!image) return { result: `No image configured for runtime ${effectiveRuntime}` }
    const secrets = await this.loadSecrets(state)
    if (typeof secrets === "string") return { result: secrets }

    const workDir = scratchWorkDir(this.deps.workRoot, sessionId)
    await mkdir(workDir, { recursive: true })
    const outDir = await mkdtemp(path.join(tmpdir(), "snippet-out-"))
    let inDir: string | undefined
    try {
      if (state.definition.inputs && Object.keys(state.definition.inputs).length > 0) {
        inDir = await mkdtemp(path.join(tmpdir(), "snippet-in-"))
        await materializeInputs(this.deps, state.definition, inDir)
      }
      const result = await this.deps.runner.run(
        {
          image,
          payload: {
            mode: "snippet",
            code,
            definition: state.definition,
            secrets,
            previousState: null,
            params: {}
          },
          mounts: { workDir, outDir, inDir },
          limits: SNIPPET_LIMITS
        },
        { onStderrLine: line => events({ type: "job_log", line }) }
      )
      const parts = [`Snippet ${result.status} (exit ${result.exitCode})`]
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
      if (result.status !== "succeeded" && result.stderrTail) parts.push(`stderr:\n${result.stderrTail}`)
      return { result: parts.join("\n") }
    } finally {
      await rm(outDir, { recursive: true, force: true })
      if (inDir) await rm(inDir, { recursive: true, force: true })
    }
  }

  /**
   * Executes one real run of the draft in the session's scratch area (draft
   * schema tables, scratch preview layers). Installed integrations are never
   * touched; cold runs certify for finish, which is what installs.
   */
  private async runIntegration(
    state: DesignerState,
    cold: boolean,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DesignerState>> {
    const definition = state.definition
    if (definition.id === "") {
      return { result: "The draft has no integration id yet; save one first with write_definition" }
    }
    try {
      validateDefinition(definition)
    } catch (err) {
      return { result: `Definition invalid: ${err instanceof Error ? err.message : String(err)}` }
    }
    const hash = definitionHash(definition)

    let runId: string
    try {
      const inserted = await this.deps.pool.query(
        `INSERT INTO app.runs (session_id, trigger, status) VALUES ($1, 'agent', 'queued') RETURNING id`,
        [sessionId]
      )
      runId = inserted.rows[0].id
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return { result: "A run of this session is already queued or running; wait for it to complete." }
      }
      throw err
    }
    const claimed = await this.deps.pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = 'designer', heartbeat_at = now(), started_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING id, integration_id, params`,
      [runId]
    )
    await executeRun(this.deps, claimed.rows[0], {
      cold,
      scratch: { sessionId, definition },
      onLogLine: line => events({ type: "job_log", line })
    })

    const final = await this.deps.pool.query("SELECT status, error, stats, log FROM app.runs WHERE id = $1", [runId])
    const { status, error, stats, log } = final.rows[0]
    const parts = [`${cold ? "Cold" : "Warm"} run ${status}.`]
    if (stats) parts.push(`stats: ${JSON.stringify(stats)}`)
    if (error) parts.push(`error: ${error}`)
    if (log) parts.push(`log tail:\n${String(log).slice(-4000)}`)

    let failStreak = state.failStreak ?? null
    let pause = false
    if (status === "succeeded") {
      failStreak = null
      parts.push("Inspect results with query_table (tables) or the stats above (snapshots).")
    } else {
      const signature = errorSignature(String(error ?? "unknown"))
      failStreak =
        failStreak && failStreak.signature === signature
          ? { signature, count: failStreak.count + 1 }
          : { signature, count: 1 }
      if (failStreak.count >= FAIL_STREAK_PAUSE) {
        pause = true
        parts.push(
          `${failStreak.count} consecutive runs failed with the same error; the session is now paused for user guidance.`
        )
      } else if (failStreak.count >= FAIL_STREAK_WARN) {
        parts.push(
          `${failStreak.count} consecutive runs have failed with the same error. Stop retrying variations: explain the problem to the user in plain text and ask how to proceed.`
        )
      }
    }

    const next: DesignerState = {
      ...state,
      lastRun: { runId, status, cold },
      coldRun: cold && status === "succeeded" ? { definitionHash: hash, runId } : state.coldRun,
      failStreak
    }
    return { result: parts.join("\n"), state: next, pause: pause || undefined }
  }

  /**
   * One read-only SELECT, capped at 50 rows. The session's scratch schema
   * shadows data, so plain table names hit this session's test output first.
   */
  private async queryTable(sql: string, sessionId: string): Promise<ToolOutcome<DesignerState>> {
    const trimmed = sql.trim()
    if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(";")) {
      return { result: "Error: a single SELECT (or WITH...SELECT) statement is required" }
    }
    const client = await this.deps.pool.connect()
    try {
      await client.query("BEGIN TRANSACTION READ ONLY")
      await client.query("SET LOCAL statement_timeout = '15s'")
      await client.query(`SET LOCAL search_path = ${draftSchema(sessionId)}, data`)
      const result = await client.query(trimmed)
      const rows = result.rows.slice(0, 50)
      return { result: `${result.rowCount} rows (showing ${rows.length}):\n${JSON.stringify(rows)}` }
    } catch (err) {
      return { result: `Query error: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
  }

  /** Presents a structured question and pauses the session for the answer. */
  private askUser(args: Record<string, unknown>): ToolOutcome<DesignerState> {
    const question = String(args.question ?? "").trim()
    const options = Array.isArray(args.options) ? args.options.map(String).filter(o => o.trim() !== "").slice(0, 5) : []
    if (question === "") return { result: "Error: question is required" }
    if (options.length < 2) return { result: "Error: provide at least two options" }
    return { result: "Question shown; the session is paused for the user's answer.", pause: true }
  }

  /**
   * The save: behind the cold-run gate, installs the certified definition as
   * the real integration (creating or updating its tables and layers) and
   * discards the session's scratch area. The integration starts empty; its
   * first production run loads data.
   */
  private async finish(state: DesignerState, summary: string, sessionId: string): Promise<ToolOutcome<DesignerState>> {
    const hash = definitionHash(state.definition)
    if (!state.coldRun || state.coldRun.definitionHash !== hash) {
      return {
        result:
          "Rejected: finish requires a successful cold run of the current definition. Run run_integration with cold=true (again if you edited anything since)."
      }
    }
    const session = await this.deps.pool.query("SELECT user_id FROM app.agent_sessions WHERE id = $1", [sessionId])
    await installIntegration(this.deps.pool, state.definition, {}, "ready", session.rows[0]?.user_id ?? null)
    await cleanupScratch(this.deps.pool, this.deps.store, this.deps.workRoot, sessionId)
    return {
      result: `Saved ${state.definition.id} as the installed integration (scratch area discarded; its first real run loads data). ${summary}`,
      finished: true
    }
  }

  /** Secret values for the draft's declared names, or an error message. */
  private async loadSecrets(state: DesignerState): Promise<Record<string, string> | string> {
    const names = state.definition.secrets ?? []
    if (names.length === 0) return {}
    if (!this.deps.secretKey) return "Error: definition declares secrets but INTEGRATOR_SECRET_KEY is not configured"
    try {
      return await getSecrets(this.deps.pool, this.deps.secretKey, names)
    } catch (err) {
      return `Error loading secrets: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

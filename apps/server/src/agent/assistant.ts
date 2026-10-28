/**
 * The query assistant (Explore): a read-only conversational agent over the data
 * schema. Answers are markdown plus typed blocks the UI renders from tool-call
 * inputs; query results live in client state, complete or rejected, never
 * truncated, so blocks and CSV downloads never show partial data.
 */

import pg from "pg"
import { LanguageModel, ToolSet, tool } from "ai"
import { z } from "zod"
import { AgentImplementation, ToolOutcome } from "./types.js"
import { executeStoredQuery } from "../dashboards/queries.js"
import { lookupCountry } from "../countries.js"
import { searchLibrary } from "./libraryTool.js"
import { describeSchema, RASTER_SQL_GUIDE } from "./shared.js"
import { getDefaultAoi } from "../settings.js"

/** Hard cap on rows per stored result; over-cap queries are rejected. */
const ASSISTANT_MAX_ROWS = 1000

/** Cap on a stored result's serialized size. */
const RESULT_BYTES_MAX = 2_000_000

/** Rows echoed to the model in the query result text. */
const PREVIEW_ROWS = 25

/** Serialized-preview budget, well under the controller's tool-result cap. */
const PREVIEW_BYTES = 6000

/** One stored query result; transcript blocks bind to it by id. */
export interface AssistantResult {
  /** The SQL that produced it, shown on block expand */
  sql: string
  /** Column names in result order */
  columns: string[]
  /** Complete result rows */
  rows: Record<string, unknown>[]
}

/** One executed statement: the stored result plus the state now holding it. */
interface StoredRun {
  /** Result id the transcript and later tool calls reference */
  id: string
  /** Column names in result order */
  columns: string[]
  /** Complete result rows */
  rows: Record<string, unknown>[]
  /** Session state with this result added */
  state: AssistantState
}

/** Client state of an assistant chat session. */
export interface AssistantState {
  /** Stored query results by id ("q1", "q2", ...) */
  results: Record<string, AssistantResult>
  /** Ordinal of the next result id */
  nextResult: number
}

/** Everything the assistant needs. */
export interface AssistantDeps {
  /** Database pool */
  pool: pg.Pool
  /** Language model for the session loop */
  model: LanguageModel
  /** Library root, for search_library; absent means no library */
  libraryPath?: string | null
}

/** Fresh state for a new assistant session. */
export function initialAssistantState(): AssistantState {
  return { results: {}, nextResult: 1 }
}

/** Chart spec accepted by show_chart (the kit Chart declarative subset). */
interface ShowChartInput {
  resultId: string
  title: string
  type: "line" | "area" | "bar" | "pie" | "scatter"
  x: string
  series: string[]
  labels?: Record<string, string>
  stacked?: boolean
  xType?: "category" | "time"
}

/** One catalog raster layer drawn by show_map. */
interface MapLayerInput {
  layerId: string
  at?: string
  label?: string
  opacity?: number
}

/** One overlay drawn by show_map from a stored result's rows. */
interface MapOverlayInput {
  resultId: string
  geojsonColumn?: string
  lonColumn?: string
  latColumn?: string
  label?: string
  color?: string
  popup?: string
}

/** Map spec accepted by show_map. */
interface ShowMapInput {
  title?: string
  layers?: MapLayerInput[]
  overlays?: MapOverlayInput[]
  fit?: boolean
}

const SYSTEM = `You are Explore, the data-exploration agent of the mWater Data Integrator platform. You answer
plain-language questions about the platform's ingested data by querying it and showing
the results. You are read-only: you query existing data; you never fetch new sources,
run jobs, or change anything.

# Grounding
- Every number in your answers comes from a query result in this conversation. Never
  estimate, extrapolate, or fill gaps from memory.
- Call list_schema before your first query (and again when unsure); never guess table
  or column names.
- Place names and bounding boxes come from lookup_country, never from memory.
- When asked for data that is not in the schema, say so plainly, then call
  search_library with the request's key terms. If an entry covers it, name it and
  give its install link exactly as returned, as a markdown link (an editor installs
  it in one click; the data arrives after the first run). If nothing fits, give the
  design-session link the tool returns, which opens a design session with the
  request already written. Never send the user off to "find a source" themselves,
  and do not approximate the missing data from what exists unless the user asks.
- The same applies when the inputs exist but the answer needs processing beyond
  SQL's reach (see the raster guide): name the inputs that exist, say an integration
  must compute the derivation (it can consume other installed data as inputs), check
  search_library for one, and otherwise give the design-session link rather than
  standing in a SQL approximation.
- Installed data covers the deployment's area of interest because it was clipped to
  that area when ingested. When asked about a place outside it, say exactly that
  (not that access is forbidden) and explain that an integration can be installed
  with its own area to cover it.
- The clipping window is a rectangle; the country is not. Any share, mean or count
  "of the country" or "of the area" comes from aoi_stats() over the area-of-interest
  shape (see the raster guide), never from the bounding box: an envelope counts
  ocean and neighbouring land. Report the coverage it returns alongside the number.
- Most users are water and sanitation staff, not GIS specialists. Explain a domain
  term in plain words the first time it appears in a conversation, e.g. "dekadal
  (every 10 days)", then use it freely.

# Queries
One SELECT (or WITH...SELECT) per query call, no semicolons, literal values inlined
(no $n parameters - where the raster examples below show $1, inline a literal).
Results over 1000 rows are rejected, not truncated: aggregate in SQL, or LIMIT for
top-N. The 15s statement timeout is real - filter before you scan.
- Cast numeric aggregates so JSON carries numbers: round(...)::float8, count(*)::int.
- to_char dates for display columns; keep raw ISO dates for chart time axes.
- Geometry columns: select ST_AsGeoJSON(geom) or ST_X/ST_Y ::float8, never a raw
  geometry column.
- Buffers in meters cast through geography: ST_Buffer(geom::geography, 500)::geometry.

# Raster values in SQL
${RASTER_SQL_GUIDE}

# Showing results
query is how you investigate: its results are yours alone, so test your SQL, check
shapes and ranges, and iterate as much as you need. Only the show_ tools put anything
in front of the user, so nothing half-finished is ever on screen - work the question
out with query first, then show the result you are happy with. Do not paste rows into
your prose; summarize what matters and refer to the block.
- show_table runs its own statement and shows the complete result as a table carrying
  its SQL and a CSV download. Show the results your answer rests on, not every step.
  Always pass labels: human-readable column headers; raw SQL ids never face the user.
- show_chart binds a chart to a result_id (from query or show_table). Forms: trend = line/area, comparison = bar,
  composition with few slices = pie, relation between two measures = scatter. Use
  xType "time" with raw ISO date x values for time series. One value axis by design:
  two scales means two charts or index the data. Give multi-series charts labels.
- show_map draws catalog raster layers (layerId from list_schema; optional "at" date
  picks the snapshot covering it on time-series layers) and/or overlays built from a
  result's rows (an ST_AsGeoJSON column, or lon/lat columns). Prefer fit; label every
  layer and overlay. The platform holds data only for the deployment area (list_schema
  names it): every layer and table is already clipped to it, so a wider "context" or
  "surroundings" view of the same layer shows exactly the same picture - never show
  the same layer at the same date twice in one answer.

# Conversation
Answer, then stop: your plain-text answer ends the turn. When a choice is not forced
(which metric, which period, which breakdown), ask instead of guessing. Your text
renders as markdown.`

/** The assistant agent implementation on the shared session harness. */
export class AssistantImplementation implements AgentImplementation<AssistantState> {
  readonly kind = "assistant" as const
  readonly model: LanguageModel
  // Lifetime cap is cumulative across the chat's life, so it stays high;
  // stepsPerRun bounds a single thrashing turn instead
  readonly maxSteps = 1000
  readonly stepsPerRun = 16
  private deps: AssistantDeps

  /** Creates the implementation over its dependencies. */
  constructor(deps: AssistantDeps) {
    this.deps = deps
    this.model = deps.model
  }

  /** System prompt; state-independent. */
  system(): string {
    return SYSTEM
  }

  /** Tool schemas; execution goes through execute(). */
  tools(): ToolSet {
    return {
      list_schema: tool({
        description:
          "List the queryable data tables (columns, types, units) and raster layers (bands, temporality). Call this before your first query; never guess table or column names.",
        inputSchema: z.object({})
      }),
      query: tool({
        description:
          "Investigate the data: run one read-only SELECT against the data schema (tables plus the rasters mirror) and get back a preview and a result_id. The user never sees these results, so explore and iterate freely. Max 1000 rows. Inline literal values; no parameters.",
        inputSchema: z.object({
          sql: z.string().describe("A single SELECT (or WITH...SELECT) statement")
        })
      }),
      show_table: tool({
        description:
          "Show a result to the user as a table block with its SQL and a CSV download. Runs its own statement, under the same rules as query; check the statement with query first, then show the result you want the user to have.",
        inputSchema: z.object({
          sql: z.string().describe("A single SELECT (or WITH...SELECT) statement"),
          title: z.string().describe("Short title shown above the table"),
          labels: z
            .record(z.string(), z.string())
            .optional()
            .describe("Human-readable header per column id; raw SQL ids never face the user")
        })
      }),
      show_chart: tool({
        description:
          "Show a chart bound to a stored query result. Declarative only. One value axis by design: two scales means two charts or index the data.",
        inputSchema: z.object({
          resultId: z.string().describe("result_id of a prior query"),
          title: z.string().describe("Short title shown above the chart"),
          type: z
            .enum(["line", "area", "bar", "pie", "scatter"])
            .describe("Pick by the data's job: trend=line/area, comparison=bar, composition (few slices)=pie, relation=scatter"),
          x: z.string().describe("Column for the x axis (slice label for pie)"),
          series: z.array(z.string()).min(1).describe("Value columns plotted as series; pie takes exactly one"),
          labels: z.record(z.string(), z.string()).optional().describe("Display label per series column"),
          stacked: z.boolean().optional().describe("Stack bar/area series"),
          xType: z.enum(["category", "time"]).optional().describe("time for date/timestamp x values")
        })
      }),
      show_map: tool({
        description:
          "Show a map: catalog raster layers and/or overlays built from a stored query result's rows. Overlay geometry comes from an ST_AsGeoJSON(...) column or lon/lat number columns.",
        inputSchema: z.object({
          title: z.string().optional().describe("Short title above the map"),
          layers: z
            .array(
              z.object({
                layerId: z.string().describe("Raster layer id from list_schema"),
                at: z.string().optional().describe("YYYY-MM-DD; draws the snapshot covering this date (default: current)"),
                label: z.string().optional().describe("Legend title"),
                opacity: z.number().min(0).max(1).optional()
              })
            )
            .optional()
            .describe("Catalog raster layers, bottom to top"),
          overlays: z
            .array(
              z.object({
                resultId: z.string().describe("result_id of a prior query"),
                geojsonColumn: z.string().optional().describe("Column holding ST_AsGeoJSON output"),
                lonColumn: z.string().optional().describe("Longitude number column (pair with latColumn)"),
                latColumn: z.string().optional().describe("Latitude number column"),
                label: z.string().optional().describe("Legend title"),
                color: z.string().optional().describe("Overlay color (defaults to a theme series color)"),
                popup: z.string().optional().describe("Column shown on feature click")
              })
            )
            .optional()
            .describe("GeoJSON overlays from query rows"),
          fit: z.boolean().optional().describe("Fit viewport to overlay data (default true when overlays exist)")
        })
      }),
      lookup_country: tool({
        description:
          "Look up country bounding boxes in the product's built-in list (Natural Earth derived) by name or ISO 3166-1 alpha-3 code. The authoritative source for coordinates: the same data the UI pickers use.",
        inputSchema: z.object({
          query: z.string().describe("Country name (partial matches allowed) or ISO3 code")
        })
      }),
      search_library: tool({
        description:
          "Search the deployment's integration Library for ready-made sources matching a request (plain words: 'river discharge', 'drought', 'population'). Returns matching entries with install status, what they produce, and the links to give the user: an install link for entries not yet installed, or a design-session link when nothing fits.",
        inputSchema: z.object({
          query: z.string().describe("The data being asked for, in plain words")
        })
      })
    }
  }

  /** Executes one tool call. */
  async execute(
    name: string,
    input: unknown,
    state: AssistantState,
    events?: unknown,
    sessionId?: string
  ): Promise<ToolOutcome<AssistantState>> {
    const args = (input ?? {}) as Record<string, unknown>
    switch (name) {
      case "list_schema": {
        const aoi = await getDefaultAoi(this.deps.pool)
        const coverage = aoi
          ? `Deployment area of interest: ${aoi.name ?? "unnamed"} (bbox ${JSON.stringify(aoi.bbox)}). All tables and layers are clipped to this area; no data exists outside it.\n\n`
          : ""
        // Display names resolve to the locale the chat was opened in, so the
        // assistant titles tables the way the user's catalog does
        const locale = sessionId
          ? ((await this.deps.pool.query("SELECT locale FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
              ?.locale ?? "en")
          : "en"
        return { result: coverage + (await describeSchema(this.deps.pool, locale)) }
      }
      case "query":
        return await this.query(state, String(args.sql ?? ""))
      case "show_table":
        return await this.showTable(state, String(args.sql ?? ""))
      case "show_chart":
        return this.showChart(state, args as unknown as ShowChartInput)
      case "show_map":
        return await this.showMap(state, args as unknown as ShowMapInput)
      case "lookup_country":
        return { result: lookupCountry(String(args.query ?? "")) }
      case "search_library":
        return { result: await searchLibrary(this.deps.pool, this.deps.libraryPath ?? null, String(args.query ?? ""), await this.sessionLocale(sessionId)) }
      default:
        return { result: `Unknown tool ${name}` }
    }
  }

  /** Locale the chat was opened in, so library names read the way the user's catalog does. */
  private async sessionLocale(sessionId?: string): Promise<string> {
    if (!sessionId) return "en"
    const row = (await this.deps.pool.query("SELECT locale FROM app.agent_sessions WHERE id = $1", [sessionId])).rows[0]
    return row?.locale ?? "en"
  }

  /**
   * Runs one guarded SELECT and stores the complete result under a fresh id.
   * Shared by query and show_table: the SQL path is identical, only whether the
   * user sees the result differs.
   */
  private async runSql(state: AssistantState, sql: string): Promise<StoredRun | { error: string }> {
    const trimmed = sql.trim()
    if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(";")) {
      return { error: "Error: a single SELECT (or WITH...SELECT) statement without semicolons is required" }
    }
    let rows: Record<string, unknown>[]
    try {
      rows = await executeStoredQuery(
        this.deps.pool,
        { name: "assistant", sql: trimmed, params: [], maxRows: ASSISTANT_MAX_ROWS },
        {}
      )
    } catch (err) {
      return { error: `Error: query failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const bytes = JSON.stringify(rows).length
    if (bytes > RESULT_BYTES_MAX) {
      return {
        error: `Error: result too large (${bytes} bytes); select fewer columns, simplify geometry (ST_SimplifyPreserveTopology), or aggregate`
      }
    }
    const id = `q${state.nextResult}`
    const columns = Object.keys(rows[0] ?? {})
    return {
      id,
      columns,
      rows,
      state: {
        results: { ...state.results, [id]: { sql: trimmed, columns, rows } },
        nextResult: state.nextResult + 1
      }
    }
  }

  /** Investigation query: stored and previewed to the model, never shown. */
  private async query(state: AssistantState, sql: string): Promise<ToolOutcome<AssistantState>> {
    const run = await this.runSql(state, sql)
    if ("error" in run) return { result: run.error }
    return { result: previewText(run, false), state: run.state }
  }

  /** Runs a statement and shows its complete result to the user as a table. */
  private async showTable(state: AssistantState, sql: string): Promise<ToolOutcome<AssistantState>> {
    const run = await this.runSql(state, sql)
    if ("error" in run) return { result: run.error }
    return { result: previewText(run, true), state: run.state }
  }

  /** Validates a chart spec against its stored result; the block is the input. */
  private showChart(state: AssistantState, spec: ShowChartInput): ToolOutcome<AssistantState> {
    const result = state.results[spec.resultId]
    if (!result) return { result: `Error: unknown result "${spec.resultId}"; run query first` }
    const missing = [spec.x, ...spec.series].filter((c) => !result.columns.includes(c))
    if (missing.length > 0) {
      return { result: `Error: column(s) ${missing.join(", ")} not in ${spec.resultId} (has: ${result.columns.join(", ")})` }
    }
    if (spec.type === "pie" && spec.series.length !== 1) {
      return { result: "Error: pie takes exactly one series column" }
    }
    const notes: string[] = []
    if (spec.series.length > 8) notes.push("note: more than 8 series exceeds the theme's color slots; fold the tail into an 'Other'")
    for (const col of spec.series) {
      const sample = result.rows.find((r) => r[col] != null)?.[col]
      if (sample !== undefined && typeof sample !== "number") {
        notes.push(`note: column "${col}" has non-numeric values (bigint/numeric arrive as strings; cast ::float8 or ::int in SQL)`)
      }
    }
    return { result: [`Chart "${spec.title}" is shown to the user, bound to ${spec.resultId}.`, ...notes].join("\n") }
  }

  /** Validates a map spec: known layers, resolvable overlay geometry. */
  private async showMap(state: AssistantState, spec: ShowMapInput): Promise<ToolOutcome<AssistantState>> {
    // Models send "" for optional fields they mean to omit
    const layers = (spec.layers ?? []).map((l) => ({ ...l, at: blank(l.at), label: blank(l.label) }))
    const overlays = (spec.overlays ?? []).map((o) => ({
      ...o,
      geojsonColumn: blank(o.geojsonColumn),
      lonColumn: blank(o.lonColumn),
      latColumn: blank(o.latColumn),
      label: blank(o.label),
      color: blank(o.color),
      popup: blank(o.popup)
    }))
    if (layers.length === 0 && overlays.length === 0) {
      return { result: "Error: give at least one layer or overlay" }
    }
    if (layers.length > 0) {
      const known = await this.deps.pool.query(
        "SELECT id FROM app.raster_layers WHERE integration_id IS NOT NULL AND id = ANY($1)",
        [layers.map((l) => l.layerId)]
      )
      const ids = new Set(known.rows.map((r: { id: string }) => r.id))
      const unknown = layers.filter((l) => !ids.has(l.layerId))
      if (unknown.length > 0) {
        return { result: `Error: unknown raster layer(s) ${unknown.map((l) => l.layerId).join(", ")}; use ids from list_schema` }
      }
      const badAt = layers.find((l) => l.at !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(l.at))
      if (badAt) return { result: `Error: at must be YYYY-MM-DD (got "${badAt.at}")` }
    }
    let features = 0
    for (const overlay of overlays) {
      const result = state.results[overlay.resultId]
      if (!result) return { result: `Error: unknown result "${overlay.resultId}"; run query first` }
      const err = overlayError(overlay, result)
      if (err) return { result: `Error: ${err}` }
      features += result.rows.length
    }
    return {
      result: `Map is shown to the user (${layers.length} layer(s), ${overlays.length} overlay(s), ${features} feature(s)).`
    }
  }
}

/** Builds the result text for a run: id line, counts, and a bounded preview. */
function previewText(run: StoredRun, shownToUser: boolean): string {
  const { id, columns, rows } = run
  const shown = rows.slice(0, PREVIEW_ROWS)
  const parts: string[] = []
  let bytes = 0
  let clipped = false
  for (const row of shown) {
    const s = JSON.stringify(row)
    if (bytes + s.length > PREVIEW_BYTES) {
      clipped = true
      break
    }
    parts.push(s)
    bytes += s.length
  }
  const label = parts.length >= rows.length ? `all ${rows.length} rows` : `first ${parts.length} of ${rows.length} rows`
  return [
    `result_id: ${id}`,
    `rows: ${rows.length}`,
    `columns: ${columns.join(", ")}`,
    `preview (${label}):`,
    `[${parts.join(",")}]${clipped ? " [preview clipped]" : ""}`,
    shownToUser
      ? "The full result is shown to the user as a table with its SQL and a CSV download. Bind charts or maps to it by result_id."
      : "The user does not see this result. Show it with show_table, or bind a chart or map to it by result_id."
  ].join("\n")
}

/** Checks one overlay's geometry declaration against its result; null when fine. */
function overlayError(overlay: MapOverlayInput, result: AssistantResult): string | null {
  const hasGeojson = overlay.geojsonColumn !== undefined
  const hasLonLat = overlay.lonColumn !== undefined || overlay.latColumn !== undefined
  if (hasGeojson === hasLonLat) {
    return `overlay ${overlay.resultId}: give exactly one of geojsonColumn or lonColumn+latColumn`
  }
  const need = hasGeojson ? [overlay.geojsonColumn!] : [overlay.lonColumn, overlay.latColumn]
  if (!hasGeojson && (overlay.lonColumn === undefined || overlay.latColumn === undefined)) {
    return `overlay ${overlay.resultId}: lonColumn and latColumn go together`
  }
  const missing = [...need, ...(overlay.popup ? [overlay.popup] : [])].filter(
    (c) => c !== undefined && !result.columns.includes(c)
  )
  if (missing.length > 0) {
    return `overlay ${overlay.resultId}: column(s) ${missing.join(", ")} not in the result (has: ${result.columns.join(", ")})`
  }
  const first = result.rows[0]
  if (!first) return null
  if (hasGeojson) {
    const cell = first[overlay.geojsonColumn!]
    const parsed = typeof cell === "string" ? tryParse(cell) : cell
    if (parsed === null || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      return `overlay ${overlay.resultId}: column "${overlay.geojsonColumn}" does not hold GeoJSON (use ST_AsGeoJSON(geom))`
    }
  } else {
    const lon = first[overlay.lonColumn!]
    const lat = first[overlay.latColumn!]
    if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      return `overlay ${overlay.resultId}: lon/lat columns must be numbers (select ST_X(geom)::float8, ST_Y(geom)::float8)`
    }
  }
  return null
}

/** JSON.parse returning null on failure. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Empty or whitespace-only strings become undefined. */
function blank(value: string | undefined): string | undefined {
  return value == null || value.trim() === "" ? undefined : value
}

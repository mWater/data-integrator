import pg from "pg"
import { LanguageModel, ToolSet, tool } from "ai"
import { z } from "zod"
import { AgentEventListener, AgentImplementation, ToolOutcome } from "./types.js"
import { buildDashboard } from "../dashboards/build.js"
import { DashboardQuery, executeStoredQuery, validateQueries } from "../dashboards/queries.js"
import { saveDashboard } from "../dashboards/service.js"
import { describeSchema, RASTER_SQL_GUIDE } from "./shared.js"

/** Build outcome carried in client state; the preview mounts bundleJs/bundleCss. */
export interface DashboardBuild {
  /** Monotonic build counter; the UI reloads the preview when it changes */
  rev: number
  /** True when the source compiled and typechecked */
  ok: boolean
  /** Compile/typecheck errors when not ok */
  errors: string[]
  /** Compiled ESM for the preview frame */
  bundleJs?: string
  /** Compiled stylesheet for the preview frame */
  bundleCss?: string
}

/** Client state of a dashboard design session. */
export interface DashboardAgentState {
  /** Bound dashboard id; empty until finish names it */
  dashboardId: string
  /** Draft display name */
  name: string
  /** Draft React source (single file, default export) */
  source: string
  /** Draft stored queries */
  queries: DashboardQuery[]
  /** Latest build outcome; null before the first write_source */
  build: DashboardBuild | null
  /** Saved version, once finish succeeded */
  saved: { version: number } | null
  /** Data-table schema block injected into the system prompt */
  schemas: string
}

/** Everything the dashboard agent needs. */
export interface DashboardDeps {
  /** Database pool */
  pool: pg.Pool
  /** Language model for the session loop */
  model: LanguageModel
}

/** Fresh state for a new dashboard session; schemas are captured at creation. */
export async function initialDashboardState(pool: pg.Pool, dashboardId = ""): Promise<DashboardAgentState> {
  const schemas = await describeSchema(pool)
  const state: DashboardAgentState = {
    dashboardId,
    name: "",
    source: "",
    queries: [],
    build: null,
    saved: null,
    schemas
  }
  if (dashboardId !== "") {
    const existing = await pool.query(
      `SELECT d.name, v.source, v.queries FROM app.dashboards d
       JOIN app.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.current_version
       WHERE d.id = $1`,
      [dashboardId]
    )
    if (existing.rows.length > 0) {
      state.name = existing.rows[0].name
      state.source = existing.rows[0].source
      state.queries = existing.rows[0].queries
      // Build the saved source now so the preview panel is live from the first
      // frame; it also surfaces drift from the current kit before any edit
      const built = await buildDashboard(state.source)
      state.build = built.ok
        ? { rev: 1, ok: true, errors: [], bundleJs: built.bundleJs, bundleCss: built.bundleCss }
        : { rev: 1, ok: false, errors: built.errors }
    }
  }
  return state
}

/** System prompt: kit surface, source and query contracts, and the workflow. */
const SYSTEM = `You are the dashboard designer for the Data Integrator platform. You design one
analytical dashboard per session: a single React source file over a fixed component kit,
plus named parameterized SQL queries frozen with the dashboard. Viewers never send SQL;
they execute your stored queries with typed parameter values.

# Source contract
One TypeScript React file. Default export is the root component, receiving
{locale, theme, initialState?, onStateChange?}. The ONLY legal imports are "react" and
"@kit/ui"; anything else fails the build. Free-form JSX is allowed, but prefer the kit.

# @kit/ui surface
- <Page title subtitle? controls?>: page scaffold; put a <FilterBar> in controls.
- <Grid columns={2|3|4}>: responsive card grid. <Card title? wide?>: content surface.
- <StatTile label value detail? status?>: one headline number (use for single values).
- <Chart type="line|area|bar|pie|scatter" data x series labels? stacked? height? format?
  xType? zoom? label?>: data is rows; x names the category column; series names value columns
  (colors follow series order automatically; max ~8). One value axis by design - for
  two scales use two charts. Pie takes exactly one series column and few slices.
  xType="time" draws a true time axis - pass raw ISO date/timestamp x values, don't
  to_char-bucket for display. Scatter relates two measures (numeric x by default).
  zoom adds interactive zooming for long series.
- <DataTable data columns? caption? height?>: accessible table view of rows.
- <EChart option label? height?>: raw ECharts option with the theme (palette, ink, fonts)
  merged underneath. Registered forms: bar/line/pie/scatter/heatmap plus grid/legend/
  tooltip/dataZoom/markLine/markArea/visualMap.
- <FilterBar>, <Select label options value onChange allLabel?>,
  <MultiSelect label options value onChange>, <DateRange label from to onChange>:
  plain value/onChange controls; wire their state into useQuery params.
- <MarkdownBlock>: narrative text.
- <MapView vector? geojson? layers? center? zoom? fit? height? onFeatureClick?>: interactive map
  with an automatic basemap (attribution handled for you; degrades to a plain
  background offline). geojson is [{data: FeatureCollection, color?, radius?,
  fillOpacity?, popup?}] - build features from query rows (lon/lat columns or
  ST_AsGeoJSON); a feature "color" property overrides the overlay color; popup
  names the property shown on click. layers draws raster catalog layers by
  layerId: [{layerId, snapshotId?, opacity?, label?, colorMap?}], server-rendered
  from the COG with the layer's own color ramp. This is ALWAYS the right way to
  draw a raster - never convert pixels to points or polygons through a tile
  query to get a map of raster values. For a date-driven map (time slider,
  month picker) take the snapshot list from useLayers(), let the control pick
  one, and pass its id as snapshotId; omitting snapshotId draws the layer's
  current snapshot. Use SQL over the rasters table for raster NUMBERS
  (statistics, values at features), not for drawing the surface.
  Prefer fit={true} over hand-computed center/zoom so the viewport
  tracks the data. NEVER overlay hand-projected SVG/HTML markers on the map -
  use geojson, which pans and zooms correctly.
  vector is [{query, params?, color?, colorBy?, radius?, radiusBy?, fillOpacity?,
  popup?, minzoom?, maxzoom?}] and draws a TILE query (tile: true, see query
  contract) as server-rendered vector tiles: only visible tiles reach the
  browser, so it scales to millions of features. Use vector whenever a layer
  could exceed a few thousand features; use geojson only for small result sets.
  colorBy is {kind: "categorical", property, values: [{value, color, label?}],
  otherwise?} or {kind: "ramp", property, stops: [{value, color}]}; radiusBy is
  {property, stops: [{value, radius}]} (pair it with grid-aggregated counts).
  popup names the tile attribute shown on click. fit cannot see tile bounds, so
  give vector-only maps center/zoom. Pick colors from the theme series tokens.
  onFeatureClick(event) fires when a vector or geojson feature is clicked, with
  {source: "vector"|"geojson", layer, properties, lngLat}: use it to drive React
  state - open a detail panel or modal, select a district, filter the rest of
  the dashboard. It is independent of popup, so set popup for a quick label,
  onFeatureClick for anything richer, or both. Raster layers do not fire it.
  Maps render an automatic legend from what layers declare - ALWAYS fill it in:
  give every layer a label (its legend title; on plain-colored vector/geojson
  layers the label alone adds a swatch entry), raster layers a colorMap
  ([{value, color, label?}] - COPY the layer's tile colorMap from the raster
  layer listing verbatim, minus fully-transparent stops; the tiles are
  server-rendered with those exact colors, so invented colors mismatch the
  map), and colorBy scales legend themselves (categorical values as swatch
  rows, ramps as a labeled gradient). legend={false} hides it.
- useQuery(name, params?) -> {data, loading, error}: executes a stored query.
- useMeta() -> {tables: {tableId: lastUpdatedIso}}: freshness for "data as of".
- useLayers() -> [{id, name, temporality, snapshots: [{id, observedAt, observedEnd}]}]:
  the raster catalog with each layer's snapshot timeline, oldest first. Drive
  date controls from it and pass the chosen snapshot id to MapView layers.
- useTheme(), useLocale(): resolved tokens and locale.

# Query contract
Each query: {name (snake_case), sql, params: [{name, type: text|number|integer|boolean|
date|datetime, required?}], maxRows?}. The SQL references params POSITIONALLY: $1 is
params[0], $2 is params[1]. Optional filters use the idiom:
  WHERE ($1::text IS NULL OR region = $1)
and the component passes null for "all". Queries run read-only against the data schema
(plain table names, no schema prefix), statement timeout 15s, row-capped: aggregate in
SQL rather than shipping raw rows. Cast dates for display (to_char) or chart buckets in
SQL. Numeric aggregates: cast round(...) results to ::float8 so JSON carries numbers.
PostGIS functions are available: for geometry columns select ST_X/ST_Y ::float8 (or
ST_AsGeoJSON) for MapView geojson features - never select raw geometry to parse client-side.

# Raster values in SQL
${RASTER_SQL_GUIDE}

Tile queries ({..., tile: true}) serve MVT vector tiles for MapView vector layers
instead of rows; row caps do not apply. The SQL must select the raw geometry column
aliased exactly "geom" (SRID 4326 - no ST_AsGeoJSON) plus a FEW scalar attribute
columns; every attribute is encoded into every tile, so keep the list short. The
server wraps the query per tile (envelope filter using the spatial index, clip, MVT
encode); tiles over 2 MB are rejected - that means the query needs level of detail,
not a bigger limit. For level of detail declare a parameter named "zoom" (type
integer); the server binds the tile zoom to it. Aggregate at low zoom and go raw
deep, e.g. with params [{name: "zoom", type: "integer"}]:
  SELECT ST_Centroid(ST_Collect(geom)) AS geom, count(*)::int AS n
  FROM sites WHERE $1 < 9 GROUP BY ST_SnapToGrid(geom, 360.0 / 2 ^ ($1 + 6))
  UNION ALL
  SELECT geom, 1 AS n FROM sites WHERE $1 >= 9
Style the aggregated branch with radiusBy/colorBy on "n". Point layers with at most
tens of thousands of rows can skip aggregation; polygon/line layers usually need
none at all.

# Data tables
{{SCHEMAS}}

# Workflow
1. Explore the data with sample_query (real SQL, 50-row cap) to learn shapes and ranges.
2. Propose the dashboard plan in plain text (sections, charts, filters) and confirm
   with ask_user before building, unless the request already pins it down.
3. set_queries for the data; write_source for the React file. Every write_source /
   edit_source rebuilds automatically and returns compile/typecheck errors - fix them
   before moving on. The user sees a live preview beside the chat after each
   successful build; they may report runtime errors from it.
4. finish({id, name}) saves the dashboard (id is permanent, snake_case/kebab-case).
   It is rejected while the latest build has errors.

Chart guidance: pick the form by the data's job (trend = line/area, comparison = bar,
single value = StatTile, composition with few parts = pie, relation = scatter, detail =
DataTable). Use Chart; reach for EChart only when Chart cannot express the form; never
hand-roll SVG charts. Give every Chart and EChart a label: one plain sentence saying
what it shows, read by screen readers (the Card title does not name the canvas).
Number and date formatting (Chart format, ECharts formatters): use Intl.NumberFormat /
Intl.DateTimeFormat over useLocale(); NEVER hardcode a locale like "en-US". In EChart
options prefer template strings ("{b}: {c}") where they suffice; write formatter
functions only when templates cannot express it.
Series colors are assigned by order and must keep their meaning
across filters. Give every multi-series chart labels; keep grids and axes recessive
(the kit does this).

Rules: never fabricate data; if a query returns nothing, say so and ask. Whenever a
choice is not forced (which metric, which period, which breakdown), ask_user rather
than guessing. Plain text with no tool calls also pauses the session. Your plain text
renders as markdown.`

/**
 * The dashboard designer agent: explore data, freeze queries, write kit-based
 * React source with automatic builds, finish behind the clean-build gate.
 */
export class DashboardImplementation implements AgentImplementation<DashboardAgentState> {
  /** Session kind for storage */
  readonly kind = "dashboard" as const
  /** Language model for the loop */
  readonly model: LanguageModel
  /** Hard cap on model calls per session */
  readonly maxSteps = 100

  private deps: DashboardDeps

  /** Creates the implementation over a pool and model. */
  constructor(deps: DashboardDeps) {
    this.deps = deps
    this.model = deps.model
  }

  /** System prompt with the session's table schemas substituted in. */
  system(state: DashboardAgentState): string {
    return SYSTEM.replace("{{SCHEMAS}}", state.schemas)
  }

  /** Tool schemas; execution is in execute(). */
  tools(): ToolSet {
    return {
      get_dashboard: tool({
        description: "Read the current draft: name, queries, and source.",
        inputSchema: z.object({})
      }),
      write_source: tool({
        description:
          "Replace the entire React source file and rebuild. Returns build errors, or OK with the new build revision (the user's preview reloads).",
        inputSchema: z.object({
          source: z.string().describe("Complete source file text")
        })
      }),
      edit_source: tool({
        description:
          "Edit the source by exact-string replacement and rebuild. oldString must occur exactly once. Pass an empty oldString only when the source is still empty.",
        inputSchema: z.object({
          oldString: z.string().describe("Exact text to replace; empty only for initially empty source"),
          newString: z.string().describe("Replacement text")
        })
      }),
      set_queries: tool({
        description:
          "Replace the stored query list. Each query's SQL binds its params positionally ($1 = params[0]).",
        inputSchema: z.object({
          queries: z
            .array(
              z.object({
                name: z.string().describe("snake_case name useQuery() references"),
                sql: z.string().describe("Single SELECT or WITH statement"),
                params: z
                  .array(
                    z.object({
                      name: z.string().describe("Parameter name"),
                      type: z
                        .enum(["text", "number", "integer", "boolean", "date", "datetime"])
                        .describe("Value type"),
                      required: z.boolean().optional().describe("Reject null/absent values")
                    })
                  )
                  .describe("Declared parameters in positional order"),
                maxRows: z.number().int().positive().optional().describe("Row cap for this query"),
                tile: z
                  .boolean()
                  .optional()
                  .describe("Tile query: serves MVT vector tiles for MapView vector layers instead of rows")
              })
            )
            .describe("The complete query list (replaces the previous one)")
        })
      }),
      sample_query: tool({
        description:
          "Run one exploratory read-only SELECT against the data schema (50-row cap). Inline literal values rather than parameters.",
        inputSchema: z.object({
          sql: z.string().describe("A single SELECT (or WITH...SELECT) statement")
        })
      }),
      ask_user: tool({
        description:
          "Ask the user a question with selectable options and pause until they answer. Use it to confirm the plan and for any unforced choice (metric, period, breakdown, layout).",
        inputSchema: z.object({
          question: z.string().describe("The question, markdown allowed; include the context needed to choose"),
          options: z.array(z.string()).min(2).max(5).describe("Short answer choices (2-5)")
        })
      }),
      finish: tool({
        description:
          "Save the dashboard and end the session. Rejected while the latest build has errors. The id is permanent; re-finishing an existing dashboard saves a new version.",
        inputSchema: z.object({
          id: z.string().describe("Dashboard id: lowercase letters/digits/_/-, starting with a letter"),
          name: z.string().describe("Display name"),
          summary: z.string().describe("One-paragraph summary of the dashboard")
        })
      })
    }
  }

  /** Executes one tool call. */
  async execute(
    name: string,
    input: unknown,
    state: DashboardAgentState,
    events: AgentEventListener,
    sessionId: string
  ): Promise<ToolOutcome<DashboardAgentState>> {
    void events
    const args = (input ?? {}) as Record<string, unknown>
    switch (name) {
      case "get_dashboard":
        return {
          result: JSON.stringify({ name: state.name, dashboardId: state.dashboardId, queries: state.queries, source: state.source }, null, 2)
        }
      case "write_source":
        return await this.setSource(state, String(args.source ?? ""))
      case "edit_source":
        return await this.editSource(state, String(args.oldString ?? ""), String(args.newString ?? ""))
      case "set_queries":
        return this.setQueries(state, args.queries as DashboardQuery[])
      case "sample_query":
        return await this.sampleQuery(String(args.sql ?? ""))
      case "ask_user":
        return this.askUser(args)
      case "finish":
        return await this.finish(state, args, sessionId)
      default:
        return { result: `Unknown tool ${name}` }
    }
  }

  /** Replaces the source and rebuilds. */
  private async setSource(state: DashboardAgentState, source: string): Promise<ToolOutcome<DashboardAgentState>> {
    if (source.trim() === "") return { result: "Source must not be empty" }
    return await this.rebuild({ ...state, source })
  }

  /** Exact-string edit, then rebuild. */
  private async editSource(
    state: DashboardAgentState,
    oldString: string,
    newString: string
  ): Promise<ToolOutcome<DashboardAgentState>> {
    if (oldString === "") {
      if (state.source !== "") return { result: "Source is not empty; pass the exact text to replace" }
      return await this.rebuild({ ...state, source: newString })
    }
    const first = state.source.indexOf(oldString)
    if (first === -1) return { result: "oldString not found in the source" }
    if (state.source.indexOf(oldString, first + 1) !== -1)
      return { result: "oldString occurs more than once; include more surrounding context" }
    const source = state.source.replace(oldString, newString)
    return await this.rebuild({ ...state, source })
  }

  /** Builds the current source and folds the outcome into state. */
  private async rebuild(state: DashboardAgentState): Promise<ToolOutcome<DashboardAgentState>> {
    const built = await buildDashboard(state.source)
    const rev = (state.build?.rev ?? 0) + 1
    const build: DashboardBuild = built.ok
      ? { rev, ok: true, errors: [], bundleJs: built.bundleJs, bundleCss: built.bundleCss }
      : { rev, ok: false, errors: built.errors }
    const next = { ...state, build }
    if (!built.ok) return { result: `Build failed:\n${built.errors.join("\n")}`, state: next }
    return { result: `Built OK (rev ${rev}). The preview has reloaded.`, state: next }
  }

  /** Replaces the stored query list after shape validation. */
  private setQueries(state: DashboardAgentState, queries: DashboardQuery[]): ToolOutcome<DashboardAgentState> {
    if (!Array.isArray(queries)) return { result: "queries must be an array" }
    const errors = validateQueries(queries)
    if (errors.length > 0) return { result: `Invalid queries:\n${errors.join("\n")}` }
    return { result: `Stored ${queries.length} quer${queries.length === 1 ? "y" : "ies"}.`, state: { ...state, queries } }
  }

  /** Runs one exploratory query under the sql_engine role. */
  private async sampleQuery(sql: string): Promise<ToolOutcome<DashboardAgentState>> {
    if (sql.trim() === "") return { result: "sql is required" }
    try {
      const rows = await executeStoredQuery(
        this.deps.pool,
        { name: "sample", sql, params: [], maxRows: 50 },
        {}
      )
      return { result: rows.length === 0 ? "(no rows)" : JSON.stringify(rows, null, 1) }
    } catch (err) {
      return { result: `Query failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** Pauses the session with a structured question. */
  private askUser(args: Record<string, unknown>): ToolOutcome<DashboardAgentState> {
    const options = Array.isArray(args.options) ? args.options : []
    if (options.length < 2 || options.length > 5) return { result: "Provide 2-5 options" }
    return { result: "Waiting for the user's answer.", pause: true }
  }

  /** Clean-build gate, then saves a version and binds the session. */
  private async finish(
    state: DashboardAgentState,
    args: Record<string, unknown>,
    sessionId: string
  ): Promise<ToolOutcome<DashboardAgentState>> {
    if (!state.build?.ok) {
      return { result: "finish rejected: the latest build has errors (or nothing was built yet)" }
    }
    const id = state.dashboardId || String(args.id ?? "")
    const name = String(args.name ?? "").trim() || state.name || id
    const saved = await saveDashboard(this.deps.pool, { id, name, source: state.source, queries: state.queries })
    if (!saved.ok) return { result: `Save failed:\n${saved.errors.join("\n")}` }
    await this.deps.pool.query("UPDATE app.agent_sessions SET dashboard_id = $2 WHERE id = $1", [sessionId, id])
    return {
      result: `Saved dashboard "${id}" version ${saved.version}.`,
      state: { ...state, dashboardId: id, name, saved: { version: saved.version! } },
      finished: true
    }
  }
}

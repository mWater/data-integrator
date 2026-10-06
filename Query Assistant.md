# Query Assistant

Design for the FUC-5 conversational assistant and the chart enhancements it
depends on. Written as a handoff: the decisions are made, the build has not
started.

## What is promised (FUC-5, OS-3)

A conversational assistant that lets users describe the data they want in
plain language ("rainfall and groundwater levels for southern Madagascar over
the last 6 months"), formulates the corresponding query, returns the results,
and explains them. Constraints: the model is swappable down to self-hosted
open weights; core data access works fully without the assistant or any paid
model. The assistant is a convenience layer over the read path — an easier
door to existing capability, never a new capability.

## Boundaries

- **Queries existing data only.** No job runner, no network fetching, no
  sandbox. Pulling new sources is the designer's jurisdiction (certification,
  editor role). When asked for data that is not ingested, the assistant says
  so and points at the Library or a design session.
- **Read-only by construction**, so it is available to every role including
  viewers. All SQL runs through the same guards as dashboard queries
  (`runAsSqlEngine`: sql_engine role, read-only transaction, 15s statement
  timeout, `data, public` search path, row caps).
- **No code generation.** Answers are data plus declarative specs, never
  compiled React. The dashboard frame's build/preview machinery is not used.

## Shape

An `AssistantImplementation` on the existing agent harness —
`agent_sessions.kind = 'assistant'` has been reserved in the schema since
0001. Same controller, persistence, SSE streaming, steering, Stop, model
plumbing as the designer. Sessions are persisted and listed like design
sessions: past Q&A doubles as documentation of how the data gets used.

Answers are **conversational markdown plus typed result blocks** stored in
the transcript and rendered natively by the host UI:

- **table** — rows/columns from the query tool; rendered like the data
  browser, CSV download.
- **chart** — the kit `Chart` component's declarative spec ({type, data, x,
  series, labels, stacked}) bound to a query result. The UI imports `Chart`
  and `DataTable` from `@data-integrator/kit` directly (plain themed React
  components); assistant charts and dashboard charts are the same renderer.
  The assistant emits the declarative subset only — never raw ECharts.
- **map** — {layers: [catalog layerIds], geojson from query rows, fit},
  rendered by the app's existing maplibre machinery (catalog raster layers +
  GeoJSON overlays). No MVT vector tiles in v1: those hang off stored
  per-dashboard tile queries, and row caps keep assistant results
  geojson-sized.

**Every block carries its SQL, visible on expand.** Verifiability, teaching
the query surface (knowledge transfer), and the bridge to permanence: copy
into a dashboard, or (v2) a "turn this into a dashboard" handoff seeding a
dashboard session with the assistant's queries and specs.

## Toolset

- `list_schema` — tables with columns/units plus raster layers with band
  indexes (same block the dashboard agent gets).
- `query` — one SELECT under the sql_engine guards, for the assistant's own
  investigation: the result is stored and previewed back to the model but
  never shown, so it can test and iterate without the user watching. Includes
  the full raster×vector space via `data.rasters` (out-db PostGIS); the prompt
  carries the same raster-SQL documentation as the dashboard agent: ST_Value
  at features, tile-aggregated zonal statistics, the
  ST_Intersects(ST_ConvexHull(rast), ...) filter, timeout discipline.
- `show_table` — runs its own SELECT under the same guards and emits the
  table block. Blocks are finished products, so showing one is a deliberate
  act after `query` has settled the SQL, not a side effect of querying.
- `show_chart`, `show_map` — emit blocks bound to a stored result id, from
  either `query` or `show_table`.
- `lookup_country` — reused from the designer; place names resolve against
  the baked-in gazetteer, never model memory.

## Build order

1. Chart enhancements below (small separate PR; de-risks the rendering path).
2. Server: `AssistantImplementation` + tools + prompt.
3. UI: transcript block rendering (kit imports + map block), chat page
   listed alongside sessions.

# Chart enhancements (prerequisite)

Current state: the kit `Chart` wraps ECharts (`echarts/core`, only
Bar/Line/Pie + grid/legend/tooltip registered). The dashboard frame's import
map exposes react and `@kit/ui` only, so agent code cannot import ECharts;
the CSP blocks CDNs. Time series work only as SQL-bucketed categories. The
only "escape" is hand-rolled SVG — the failure mode the design system exists
to prevent.

Two moves, both cheap because ECharts is already in the bundle:

1. **Grow the declarative `Chart`**: `xType: "time"` (true time axis),
   `type: "scatter"`, and a `zoom` flag (dataZoom) for long series. Each is
   one registered ECharts module plus a prop; theme colors and tooltip
   behavior stay automatic.
2. **One sanctioned escape hatch**: `<EChart option={...}>` passing a raw
   ECharts option through, with the theme (fonts, ink colors, series
   palette, background) merged underneath, and a curated registered-module
   set (add Scatter, Heatmap, DataZoom, MarkLine/MarkArea) rather than all
   of ECharts, keeping the bundle bounded.

Prompt rules: use `Chart`; reach for `EChart` only when `Chart` cannot
express the form; never hand-roll SVG charts. The one-value-axis rule stays
as method guidance ("two scales = two charts or index the data"), not
enforcement. The assistant's `show_chart` remains the declarative subset —
the escape hatch is a dashboard-authoring power tool reviewed in the preview
loop, not an ephemeral-answer surface.

# Time-aware MapView layers (companion piece)

Storage is fully time-aware — a time-series layer keeps one promoted
snapshot per period, each an immutable COG with observed_at/observed_end,
snapshot-pinned tile URLs, and time columns on the SQL mirror — but the
dashboard map path is not: at frame boot the host resolves each MapView
layer id to its current_snapshot_id, so dashboards can only ever draw the
newest snapshot. (The main app's Map page has a time slider; the kit does
not.) Data-level time already works via SQL.

The fix is small and follows the same grow-the-declarative-surface move as
the chart work:

- Kit `MapLayer` becomes `{layerId, at?: ISO date}` (bare string stays
  valid). The host already fetches /api/layers, which includes each layer's
  promoted snapshots; it resolves `at` to the snapshot whose period covers
  that date, falling back to current when absent — existing dashboards
  unchanged.
- The frame's tile fetch handler passes the resolved snapshot through.
  Tiles are snapshot-pinned, so switching time is switching URLs; viewed
  periods stay cached.
- Time *control* is then ordinary dashboard state, no new widget:
  `SELECT DISTINCT observed_at FROM rasters WHERE layer_id = $1 ORDER BY 1
  DESC` feeds a `<Select>`, whose value binds both the layer's `at` and the
  parameters of neighboring queries — a synchronized "pick a month, map and
  chart update together" dashboard from existing primitives.
- Document the pattern in the dashboard agent's prompt (and the assistant's
  `show_map` block gains the same optional `at` per layer).

Roughly a one-day PR: kit MapLayer + host snapshot resolution +
DashboardFrame handler + prompt update.

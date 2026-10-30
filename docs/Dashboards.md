# Dashboards

Agent-designed analytical dashboards over the integrated data. The designer agent writes
React source composing a curated component kit; all data access is named, parameterized
SQL frozen at design time and executed server-side under a locked-down role. Compiled
once at design time, rendered in a sandboxed iframe. Distinct from the ops dashboard
(pipeline health, runs, lineage), which is ordinary app UI.

The wire protocol is the core idea: viewers never send queries, they name a persisted
artifact and the server executes what an editor froze.

## Model

A dashboard is a versioned artifact:

```
Dashboard {
  id, name, currentVersion
  public, publishedBy, publishedAt   // anonymous viewing, set by an admin
  source        // single React file composing the component kit
  queries       // { name, sql, params: ParamSpec[], maxRows?, tile? }[]
  layers        // raster catalog layer ids the version may draw
  builtWithKit  // kit the bundle was built with (provenance; viewers get the current kit)
  bundleJs, bundleCss  // compiled pair, immutable per version
}
```

- Queries are frozen at design time by an editor-role author (usually the agent).
  Viewers execute stored queries by name with typed, bound parameter values. No SQL
  ever crosses the wire from a client. Dynamic filtering is expressed inside the stored
  SQL (`where $1::text is null or region = $1` idioms), taught by the design prompt.
- A query marked `tile: true` is a tile query: it serves MVT vector tiles for map
  layers instead of rows (`GET .../tiles/:name/:z/:x/:y.mvt`), the same frozen-SQL
  wire protocol extended to large geodata. The SQL selects a geometry column named
  `geom` (SRID 4326) plus a few scalar attributes; the server wraps it per tile with
  an envelope filter (planned against the GIST index), `ST_AsMVTGeom` clipping, and
  `ST_AsMVT` encoding under the query's name. Row caps do not apply; a 2 MB per-tile
  byte cap does. The reserved parameter `zoom` (integer) is bound server-side to the
  tile zoom so frozen SQL can express level of detail (grid-aggregate at low zoom,
  raw features deep); the design prompt teaches the idiom. This is what makes
  million-point layers viable: only the visible tiles' bytes reach the browser.
- `ParamSpec` is `{ name, type, required? }` with `type` one of `text`, `number`,
  `integer`, `boolean`, `date`, `datetime`. The server validates each value against its
  type, rejects a missing required one, and binds them positionally (`$1..$n` in
  declaration order).
- `layers` declares the raster catalog layers the version may draw, like its queries;
  the dashboard's raster tile route serves only those.
- Editing creates a new version with a new bundle; superseded bundles stay valid for
  in-flight viewers (immutable, like raster snapshots). Each version records who saved
  it.
- **History and restore.** The dashboard page's History menu lists the saved versions
  (`GET /api/dashboards/:id/versions`). Restoring one
  (`POST /api/dashboards/:id/versions/:version/restore`, editors and admins) saves a
  copy of it as a new current version, recording the version it copied, so history
  stays linear and a restore can itself be undone. The copy reuses the stored bundle,
  which runs on the current kit because kit exports are append-only. Design sessions
  open on the dashboard keep their drafts, which become unsaved changes against the
  restored version.

## Component kit

The sanctioned UI surface: generated dashboards share one component set, so
accessibility is handled once in the kit rather than in each dashboard:

- Layout primitives, stat tile, chart (ECharts, Apache 2.0), table, filter bar (wires
  control state to query params), markdown, and map.
- Map (MapLibre): automatic basemap, catalog raster layers, vector tile layers over
  stored tile queries, and GeoJSON overlays with fit-to-data and click popups; all
  bytes are proxied through the bridge. Vector styling is declarative and data-driven:
  categorical/ramp color scales and radius scales compile to MapLibre expressions, so
  generated dashboards stay on the kit surface.
- Basemap: the server proxies and disk-caches OpenFreeMap (explicitly free for
  commercial use, no key) at `/basemap/*`, rewriting style/TileJSON URLs to the
  frame's `di-basemap://` protocol. `BASEMAP_UPSTREAM` / `BASEMAP_STYLE_LIGHT` /
  `BASEMAP_STYLE_DARK` swap providers per deployment; `off` disables. Attribution
  renders in-map. Offline or disabled, MapView falls back to a plain background
  (stale cache serves previously-viewed areas). MapLibre's tile worker ships as a
  classic-script kit asset (`maplibre-worker.cjs`) because the sandboxed frame's
  opaque origin blocks module workers.
- Theme tokens for color and typography, so dashboards are brandable without forking
  the kit.
- Versioned as provenance: saved versions record the kit they were built with, but the
  loader always serves the current kit, so kit changes must stay compatible with stored
  source and bundles (exports and prop contracts are append-only); nothing rebuilds
  saved dashboards when the kit changes. Upgrading one is a recompile, usually
  agent-driven.
- The EChart escape hatch's ECharts major and registered module set are part of that
  surface: extended freely, never trimmed within a kit version.

Stack: the kit components are React source in this repo (`packages/kit`), styled with
Tailwind CSS utilities. Runtime dependencies are React, ECharts, MapLibre GL, and
`marked` with DOMPurify for Markdown; Tailwind is build-time only. Because the component
layer is source here, the kit cannot drift under an upstream restyle and the
SBOM stays small. Tailwind is chosen for LLM fluency: it is among the best-represented
styling idioms in model training data, open-weights models included. Tailwind runs in
the design-time build and emits a plain stylesheet, so generated dashboards need no
runtime style injection (CSP-friendly).

Free-form JSX is allowed at the edges; the design-session prompt hard-steers to the kit.
Composing a documented kit is a far easier task than inventing UI, which is what keeps
output acceptable on weaker self-hosted models.

## Source contract

`source` is one TypeScript React file whose default export is the root component. The
only legal imports are `react` and `@kit/ui`; the build fails on anything else, which
makes "free-form JSX, kit-only surface" enforceable rather than aspirational.

```tsx
/** Props supplied by the kit shell when mounting the dashboard. */
interface DashboardProps {
  /** BCP 47 locale for number/date formatting and kit strings. */
  locale: string
  /** Resolved theme tokens (deployment branding). */
  theme: ThemeTokens
  /** Filter/UI state restored from the host URL, if any; shape is dashboard-defined. */
  initialState?: unknown
  /** Reports state changes so the host can persist them for deep links. */
  onStateChange?: (state: unknown) => void
}

/** dashboard.tsx */
export default function Dashboard(props: DashboardProps): JSX.Element
```

- Data arrives through kit hooks, not props: `useQuery(name, params)` returns
  `{ data, loading, error }`, refetches when name or params change, drops stale
  responses, and keeps the last good rows during a refetch; `useMeta()` exposes
  freshness for "data as of" displays; `useLayers()` lists the declared raster layers
  with their snapshot timelines (pass a snapshot id to a map layer to draw that
  observation); `useTheme()` and `useLocale()` return the resolved theme tokens and the
  host's locale. Data rides the postMessage bridge underneath.
- Filter state is ordinary React state wired to kit controls (`FilterBar` is
  value/onChange); `initialState`/`onStateChange` make it deep-linkable.

## Query execution

- `POST /api/dashboards/:id/queries/:name` with `{ params }` answers `{ rows }`.
  Authorization is per dashboard (below). The server validates parameter types, binds,
  and executes.
- Dedicated `sql_engine` Postgres role: SELECT on the `data` schema only, in a
  read-only transaction with a 15 s statement timeout. Rows are capped at the query's
  `maxRows` (default 5000, at most 10000); tile queries have the per-tile byte cap
  instead. Both guards are required: READ ONLY alone does not block everything, and the
  role must lack server-program and file privileges.
- The SQL surface is `data` only. Freshness and lineage metadata for "data as of"
  displays comes from the API via the bridge, not SQL.

## Build and rendering

- Design-time compile in the server process: esbuild API (ESM output, `react`/`@kit/ui`
  external), the TypeScript compiler against the kit types, and Tailwind. Rebuilds are
  fast enough to keep the design loop tight. The job sandbox is not needed here:
  compile, typecheck, and Tailwind parse the source but never execute it; only
  execution of generated code (in the browser iframe) is isolated. Output is a JS + CSS
  pair stored immutably per version. Deliberately not a single self-contained HTML: that
  would duplicate the kit runtime (React, kit components, ECharts, MapLibre) into every
  dashboard and defeat caching.
- The kit runtime ships as versioned immutable static assets (`/kit/:version/...`),
  public (it is the app's own open-source code), shared by all dashboards on that kit
  version, long-cache.
- Mounting: the host page (the app's SPA) fetches the version's bundle and builds an
  `iframe srcdoc`: an import map pinning `react`/`@kit/ui` to the kit assets, the bundle
  JS and CSS inlined, `sandbox="allow-scripts allow-modals"`. Without
  `allow-same-origin` the frame has an opaque origin and no cookies; it makes no
  credentialed request at all.
- Everything crosses the postMessage bridge: stored-query calls and freshness metadata
  (surfaced in source as `useQuery`/`useMeta`), map tile and basemap bytes (MapLibre
  custom protocols in the kit request them from the host), runtime error reports, and
  state-change events for deep links. The host executes these with the viewer's
  session (none for an anonymous viewer of a public dashboard) against
  per-dashboard-authorized endpoints; the bridge proxies nothing else.
  The frame CSP allows `connect-src` to the app origin only (MapLibre fetches its
  worker script); the frame carries no credentials, so this reaches public assets,
  never data.
- The frame never holds a token: the host page is always the app itself. External
  embeds that fetch directly would need short-lived scoped tokens, which do not exist.
- Net effect: generated code can never see the viewer's session or reach anything an
  editor did not freeze. This bounds the editor-can-XSS-viewer risk that code output
  introduces.

## Designer agent

One more AgentImplementation on the harness (`agent_sessions.kind = 'dashboard'`):

- Tools: `get_dashboard`, `write_source`, `edit_source` (exact-string replace),
  `set_queries`, `set_layers`, `search_library`, `sample_query`, `ask_user`,
  `ready_to_save`. Table schemas are injected into
  the system prompt. There is no separate build tool: every source or query mutation
  rebuilds automatically and returns compile/typecheck errors in the tool result,
  halving the round trips per iteration.
- The design session shows the draft dashboard live beside the chat. Draft state lives
  in session client_state; the preview reloads when a tool result changes the build.
- Saving is the user's action, never the agent's, because a saved dashboard is visible
  to everyone signed in. The agent calls `ready_to_save` to propose a slug and name and
  ends its turn; a save bar above the composer (Save Dashboard, Discard Changes) shows
  while the draft has unsaved work (`client_state.dirty`, set by every source, query
  or layer change). `POST /api/sessions/:id/save` saves a version; the first save
  takes the slug from the user's dialog and refuses one another dashboard already has.
  Discard deletes the session (`DELETE /api/sessions/:id`, creator or admin); saved
  versions are untouched. Leaving the page with unsaved work asks first, and the
  draft stays listed under Drafts on the dashboard list.
- Runtime errors in the preview cross the bridge: steered into a running loop, or
  attached to the next user message when the loop is paused (never auto-resuming it,
  so a broken build cannot burn tokens unattended).
- Save gate (`ready_to_save` and the save endpoint): the latest build compiled and
  typechecked against the kit.

## Access control

- Viewers, editors and admins read every dashboard; editors and admins design, save,
  restore, rename and delete them.
- Dashboard endpoints authorize per dashboard ("may this principal view dashboard X"),
  never via a blanket data-read check: any signed-in user passes, an anonymous one only
  when the dashboard is public.
- **Public dashboards.** An admin makes a dashboard public with
  `PUT /api/dashboards/:id/public` `{ public: true }`; who did it and when are recorded
  (`published_by`, `published_at`, cleared when made private). Its view surface (detail,
  stored queries, vector tiles, declared raster tiles, freshness and sources metadata)
  then answers without a session, at the dashboard's normal URL. Anonymous viewers get
  the bundle but not the React source or the SQL. Management routes (list, save,
  rename, delete, publish) stay behind sign-in. Absent and private dashboards answer
  anonymous requests identically (401). Renaming a dashboard's id breaks its existing
  links, public ones included.

Caveat: dashboard-scoped access limits reach; it is not statistical confidentiality.
Frozen aggregates reveal what they aggregate, and filter parameters can be probed. Data
that must stay hidden from an audience does not belong in a dashboard served to that
audience.

## No-AI deployments

Viewing a dashboard needs no model: the SQL is frozen and the bundle is compiled.
Authoring needs a model, or a maintainer who saves React source and queries directly
through `POST /api/dashboards`, which runs the same build and gate.

## Schema

### dashboards

| column | type | notes |
|---|---|---|
| id | text pk | slug; renamable, references cascade |
| name | text | |
| current_version | int | |
| created_at, updated_at | timestamptz | |
| public | boolean | viewable without signing in |
| published_by | uuid fk users | admin who made it public; null while private |
| published_at | timestamptz | null while private |

### dashboard_versions

| column | type | notes |
|---|---|---|
| dashboard_id | text fk | |
| version | int | pk with dashboard_id |
| source | text | React source |
| queries | jsonb | named parameterized SQL |
| kit_version | text | |
| bundle_js | text | compiled ESM, immutable |
| bundle_css | text | Tailwind output, immutable |
| layers | jsonb | raster layer ids the version may draw |
| created_by | uuid fk users | who saved it; null when not recorded |
| restored_from | int | the version a restore copied; null for ordinary saves |
| created_at | timestamptz | |

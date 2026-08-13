# Dashboards

Agent-designed analytical dashboards over the integrated data. The designer agent writes
React source composing a curated component kit; all data access is named, parameterized
SQL frozen at design time and executed server-side under a locked-down role. Compiled
once at design time, rendered in a sandboxed iframe. Distinct from the ops dashboard
(pipeline health, runs, lineage), which is ordinary app UI.

mWater's visualization stack is not ported: it is inseparable from the Schema/Expr/JsonQL
expression stack (three more libraries, two LGPL-3.0); its server-side policy layer lives
in mwater-server and would be rewritten anyway; and most of its ~72k LOC is human
designer UI, which agentic authoring makes unnecessary. The one mWater idea kept is the
wire protocol: viewers never send queries, they name a persisted artifact and the server
executes what an editor froze.

## Model

A dashboard is a versioned artifact:

```
Dashboard {
  id, name, version
  source       // single React file composing the component kit
  queries      // { name, sql, params: ParamSpec[], maxRows? }[]
  kitVersion   // kit the bundle was built with (provenance; viewers get the current kit)
  bundle       // compiled { js, css } pair, immutable per version
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
  `ST_AsMVT` encoding under the query's name. Row caps do not apply — a 2 MB per-tile
  byte cap does. The reserved parameter `zoom` (integer) is bound server-side to the
  tile zoom so frozen SQL can express level of detail (grid-aggregate at low zoom,
  raw features deep); the design prompt teaches the idiom. This is what makes
  million-point layers viable: only the visible tiles' bytes reach the browser.
- `ParamSpec` declares name and ColumnSpec type; the server validates and binds.
- Editing creates a new version with a new bundle; superseded bundles stay valid for
  in-flight viewers (immutable, like raster snapshots).

## Component kit

The sanctioned UI surface, audited for accessibility once so generated dashboards do
not each carry their own WCAG risk:

- Layout primitives, stat tile, chart (ECharts, Apache 2.0), table, filter bar (wires
  control state to query params), markdown, map (MapLibre: automatic basemap, catalog
  raster layers, vector tile layers over stored tile queries with declarative
  data-driven styling — categorical/ramp color scales and radius scales compiled to
  MapLibre expressions, so generated dashboards stay on the audited surface — and
  GeoJSON overlays with fit-to-data and click popups; all bytes proxied through the
  bridge).
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
  source and bundles (exports and prop contracts are append-only) until a
  rebuild-on-upgrade sweep exists. Upgrades are recompiles, usually agent-driven.
- The EChart escape hatch's ECharts major and registered module set are part of that
  surface: extended freely, never trimmed within a kit version.

Stack: Tailwind CSS (pinned major version, stated in the design prompt) over vendored
shadcn-style components on Radix primitives. Radix and Tailwind are the only runtime UI
dependencies; the styled component layer is source in this repo, so the audited kit
cannot drift under an upstream restyle and the SBOM stays small. Chosen for LLM
fluency: the Tailwind/shadcn idiom is the best-represented UI stack in current model
training data, including the open-weights models OS-3 requires. Tailwind JIT runs in
the existing design-time build job and emits a plain stylesheet, so generated
dashboards need no runtime style injection (CSP-friendly). The app UI (ops dashboard,
agent UI) uses the same stack and theme tokens.

Free-form JSX is allowed at the edges; the design-session prompt hard-steers to the kit.
Composing a documented kit is a far easier task than inventing UI, which is what keeps
output acceptable on the weaker self-hosted models required by OS-3.

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
  `{ data, loading, error }`, dedupes in-flight calls, and drops stale responses;
  `useMeta()` exposes freshness for "data as of" displays. Both ride the postMessage
  bridge underneath.
- Filter state is ordinary React state wired to kit controls (`FilterBar` is
  value/onChange); `initialState`/`onStateChange` make it deep-linkable.

## Query execution

- `POST /dashboards/:id/queries/:name` with `{ params }`. Authorization is per
  dashboard (below). The server validates parameter types, binds, and executes.
- Dedicated `sql-engine` Postgres role: SELECT on the `data` schema only, read-only
  transaction, statement timeout, row and byte caps. Both guards are required: READ
  ONLY alone does not block everything, and the role must lack server-program and file
  privileges.
- The SQL surface is `data` only. Freshness and lineage metadata for "data as of"
  displays comes from the API via the bridge, not SQL.

## Build and rendering

- Design-time compile in the server process: esbuild API (ESM output, `react`/`@kit/ui`
  external), tsc against the kit types, and Tailwind JIT. Rebuilds are ~100ms, which
  keeps the design loop tight. The sandbox is not needed here: compile, typecheck, and
  Tailwind parse the source but never execute it; only execution of generated code (in
  the browser iframe) is isolated. Output is a JS + CSS pair, typically tens of KB,
  stored immutably per version. Deliberately not a single self-contained HTML: that
  would duplicate the 1-2 MB kit runtime (React, kit components, ECharts, MapLibre)
  into every dashboard and defeat caching.
- The kit runtime ships as versioned immutable static assets (`/kit/:version/...`),
  public (it is the app's own open-source code), shared by all dashboards on that kit
  version, long-cache.
- Mounting: the host page (the authenticated SPA) fetches the version's bundle and
  builds an `iframe srcdoc`: an import map pinning `react`/`@kit/ui` to the kit
  assets, the bundle JS and CSS inlined, `sandbox="allow-scripts"`. Without
  `allow-same-origin` the frame has an opaque origin and no cookies; it makes no
  credentialed request at all.
- Everything crosses the postMessage bridge: stored-query calls and freshness metadata
  (surfaced in source as `useQuery`/`useMeta`), map tile and basemap bytes (MapLibre
  custom protocols in the kit request them from the host), runtime error reports, and
  state-change events for deep links. The host executes these with the viewer's
  session against per-dashboard-authorized endpoints; the bridge proxies nothing else.
  The frame CSP allows `connect-src` to the app origin only (MapLibre fetches its
  worker script); the frame carries no credentials, so this reaches public assets,
  never data.
- No token mechanism in v0: the host page is always the app itself. Short-lived scoped
  tokens return when a frame must fetch directly (external embeds, share links).
- Net effect: generated code can never see the viewer's session or reach anything an
  editor did not freeze. This bounds the editor-can-XSS-viewer risk that code output
  introduces.

## Designer agent

One more AgentImplementation on the harness (`agent_sessions.kind = 'dashboard'`):

- Tools: `get_dashboard`, `write_source`, `edit_source` (exact-string replace),
  `set_queries`, `sample_query`, `ask_user`, `finish`. Table schemas are injected into
  the system prompt. There is no separate build tool: every source or query mutation
  rebuilds automatically and returns compile/typecheck errors in the tool result,
  halving the round trips per iteration.
- The design session shows the draft dashboard live beside the chat. Draft state lives
  in session client_state (scratch pattern: finish is the save); the preview reloads
  when a tool result changes the build.
- Runtime errors in the preview cross the bridge: steered into a running loop, or
  attached to the next user message when the loop is paused (never auto-resuming it,
  so a broken build cannot burn tokens unattended).
- `finish` gate: the bundle compiles, typechecks against the kit, and the preview has
  reported no runtime error since the last build. A headless render test is deferred
  to the library-install path, where no human watches a preview.

## Access control

Roles are unchanged: viewer reads all data and all dashboards. Two deliberate choices:

- Dashboard endpoints authorize per dashboard ("may this principal view dashboard X"),
  never via a blanket data-read check. Today every viewer passes for every dashboard,
  so behavior is identical, but the seam exists.
- A dashboard-only principal (a role below viewer, or share-link/public dashboards) is
  deferred, not designed out. Because queries are frozen and parameters typed, adding
  one is additive: grant the dashboard endpoints and layer-scoped tile tokens, nothing
  else. The realistic future demand is public early-warning dashboards via share link,
  not a fourth login role.

Recorded caveat: dashboard-scoped access limits reach; it is not statistical
confidentiality. Frozen aggregates reveal what they aggregate, and filter parameters
can be probed. Data that must stay hidden from an audience does not belong in a
dashboard served to that audience.

## Library and no-AI deployments

Dashboards ship in the versioned library like integrations: source plus queries,
compiled at install against the local kit. Deployments with no model configured still
install and view them; authoring changes need a model or a React-literate maintainer.
"Fully functional with no AI configured" stays true for dashboards.

## Schema (app schema additions)

### dashboards

| column | type | notes |
|---|---|---|
| id | text pk | natural key, library-syncable like integrations |
| name | text | |
| current_version | int | |
| created_at, updated_at | timestamptz | |

### dashboard_versions

| column | type | notes |
|---|---|---|
| dashboard_id | text fk | |
| version | int | pk with dashboard_id |
| source | text | React source |
| queries | jsonb | named parameterized SQL |
| kit_version | text | |
| bundle_js | text | compiled ESM, immutable |
| bundle_css | text | Tailwind JIT output, immutable |
| created_at | timestamptz | |

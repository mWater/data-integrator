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
  kitVersion   // component kit the bundle is pinned to
  bundle       // compiled JS, immutable per version
}
```

- Queries are frozen at design time by an editor-role author (usually the agent).
  Viewers execute stored queries by name with typed, bound parameter values. No SQL
  ever crosses the wire from a client. Dynamic filtering is expressed inside the stored
  SQL (`where $1::text is null or region = $1` idioms), taught by the design prompt.
- `ParamSpec` declares name and ColumnSpec type; the server validates and binds.
- Editing creates a new version with a new bundle; superseded bundles stay valid for
  in-flight viewers (immutable, like raster snapshots).

## Component kit

The sanctioned UI surface, audited for accessibility once so generated dashboards do
not each carry their own WCAG risk:

- Layout primitives, stat tile, chart (one chart library, Apache-2.0-friendly; ECharts
  is the leading candidate), table, filter bar (wires control state to query params),
  markdown, map (MapLibre over the tile service).
- Theme tokens for color and typography, so dashboards are brandable without forking
  the kit.
- Versioned; bundles pin the version. Upgrades are recompiles, usually agent-driven.

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

- Design-time compile in the job runner (esbuild in the node22 image). The bundle is
  the artifact; nothing is generated or compiled at view time.
- View time: sandboxed iframe (opaque origin, no cookies) with a strict CSP. The host
  page holds credentials and exposes a postMessage bridge: `dashboard.query(name,
  params)` for data, `dashboard.meta` for freshness, and short-lived tile tokens
  scoped to the referenced layers for maps (the one network path the iframe needs).
- Net effect: generated code can never see the viewer's session or reach anything an
  editor did not freeze. This bounds the editor-can-XSS-viewer risk that code output
  introduces.

## Designer agent

One more AgentImplementation on the harness (`agent_sessions.kind = 'dashboard'`):

- Tools: read data-table and catalog schemas, run design-time sample queries, edit
  source and queries, build, preview, finish.
- `finish` gate, mirroring the integration cold-run gate: the bundle compiles,
  typechecks against the kit, and passes a headless render test against real query
  results. A weak model writing broken React becomes a design-loop iteration, not a
  viewer-facing failure.

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
| bundle | text | compiled JS, immutable |
| created_at | timestamptz | |

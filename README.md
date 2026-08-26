# Data Integrator

Open-source, self-hosted platform that ingests multi-source water and climate data
(satellite rasters, gridded forecasts, sensor feeds, national databases), harmonizes it,
and stores it in PostgreSQL/PostGIS plus a file-backed raster store. Integrated data is
accessed through a documented REST API, a dashboard, and an optional AI assistant. An
agentic AI designs and tests the ingestion pipelines; pipeline code runs in sandboxed
containers (podman + gVisor).

Developed by [mWater](https://www.mwater.co) for the UNICEF WASH Innovation Hub, with
initial deployments in Angola and Madagascar.

## Status

Early development. The job runner, runtime images, and definition format exist.
The server has schema, migrations, install, a working run executor, and an HTTP
API: layer discovery, map tiles, integrations browse, and the designer session
API (REST + SSE). The
first real library integrations (WorldPop population, CHIRPS monthly rainfall)
run end to end and render on a map page with a time slider for time-series
layers. The designer agent works via CLI and via the React UI (apps/ui, served
by the server): live design sessions with streaming tool calls and job logs,
cold-run-gated finish, sessions serialized to Postgres. Design sessions run in
a session-scoped scratch area (draft schema, preview layers with map tiles);
installed integrations are untouched until finish saves the certified
definition, so editing a live integration is safe. Local accounts work:
email + password (scrypt, lockout), cookie sessions, admin/editor/viewer roles
enforced server-side, users managed via CLI. The UI covers the core operator
loop: browse the data catalog (tables and raster layers, the landing page),
browse integrations, preview table data, run manually, view layers on the
in-app map (time slider included), and design or edit integrations with the
agent. Derived integrations work: declared
inputs are materialized read-only at /in (catalog snapshots as COGs, table
extracts as gpkg/json/csv) with a manifest, and runs record snapshot-level
lineage; the first derived library entry (population-weighted rainfall) builds
on the CHIRPS and WorldPop layers. The documented query API works (see
API.md + /api/openapi.json): personal access tokens, filtered tabular reads in
json/csv/geojson, raster catalog with COG downloads - fully functional with no
AI configured. Sessions support mid-run steering (messages land at the next
step boundary) and a graceful Stop. The library is browsable in the UI with
one-click install/update (updates keep the deployment's area of interest,
schedule, and limits), and definitions are versioned with attribution: the
definition is the integration's single specification, every change archives a
version, and the integration page shows the history and an area-of-interest
editor. Integrations export as a single definition file and import on
another deployment (paused, AOI stripped), so sharing needs no common
library. A deployment default AOI (Settings page, baked-in country list) scopes
AOI-less integrations at run time, and runs record the AOI they executed with.
Promoted raster snapshots are mirrored as tiled out-db PostGIS rasters
referencing the COGs, so SQL joins raster values with vector rows (per-point
sampling, buffered zonal statistics) under the read-only sql_engine role -
pixels never enter the database. Skills - source and technique know-how in
library/skills/ - load into the designer on demand. Configuration is validated centrally at startup
(.env.example documents every variable). The scheduler runs in serve: a cron
tick enqueues runs for enabled integrations (dependency-free 5-field parser,
UTC), workers drain the queue, and a reaper fails stale runs; schedules are
editable in the UI as versioned definition changes, with a Pause toggle for
the operational off-switch. Webhook triggers are live: each integration has a
capability URL (`POST /hooks/<token>`, shown on the integration page, admin
rotation) that buffers the JSON payload and enqueues a run, immediately or at
the end of a per-integration batch window (webhookDelaySeconds) so
high-frequency feeds share one run per window; events for paused integrations
wait for re-enable. Agent compaction and cost governance are not
started.

- [Quickstart.md](Quickstart.md) - prerequisites to running server in ten minutes
- [Architecture.md](Architecture.md) - system design and core decisions
- [API.md](API.md) - the documented query interface (tokens, tables, rasters)
- [TODO.md](TODO.md) - remaining work, by area
- [Agent Harness.md](Agent%20Harness.md) - agent loop design and harness decisions
- [Database.md](Database.md) - Postgres schema, migrations, and raster store layout
- [Dashboards.md](Dashboards.md) - agent-designed dashboards: React over frozen SQL
- [packages/runner](packages/runner/) - podman + gVisor job executor (working, tested)
- [runtimes/](runtimes/) - node22 and python3.12 runtime images with job harnesses
  (working, tested)

## Major pieces

The project is complete when all of these exist.

- **Sandbox job runner** *(built)* - Executes integration code in rootless podman +
  gVisor containers with resource limits, mounts, and a public-only egress policy.
  Payload-opaque, so it ports unchanged to other hosts.
- **Runtime images** *(built)* - `node22` and `python3.12` images whose harnesses map
  the job payload onto the `run(ctx)` entrypoint. Curated libraries baked in, including
  the geospatial stack in Python.
- **Integration library** *(format, first definitions, skills, and UI browser built;
  more sources remaining)* - The machine-readable definition format and the definitions
  themselves for the target data sources (GloFAS, SPI, FPAR, DEMs, WorldPop, GHSL,
  HydroSHEDS, in-situ sensors). A standalone deliverable, independent of the
  application, including reusable skills (source and technique know-how) the agent
  loads on demand. Browsable in the UI with one-click install and update.
- **Database and migrations** *(built)* - PostgreSQL/PostGIS schema and migration
  system: destination tables, raster catalog, integrations, runs, secrets, users.
- **Web server and API** *(built)* - Node/TypeScript server with local accounts, RBAC, and the
  documented REST query interface over tabular data and the raster catalog. The
  contractual programmatic access path; fully functional with no AI configured.
- **Pipeline engine** *(executor, /in, webhooks built)* - Scheduler and DB-backed job queue:
  triggers runs (cron, webhook), materializes `/in`, registers rows and raster
  artifacts, and backfills after connectivity gaps. Evaluates validation rules and
  records lineage and freshness per run.
- **Raster catalog and tile service** *(built except STAC)* - Layers, snapshots, and
  bands over COGs in a file or S3-compatible store, with immutable snapshot promotion
  and a STAC-compatible API representation. PNG map tiles rendered from COGs via GDAL.
- **Designer agent** *(chassis + CLI)* - The agent loop (see Agent Harness.md) that
  designs, tests, and maintains integrations: snippet and async job tools, steering,
  cold-run-gated finish. Model provider is swappable, down to self-hosted open weights.
- **Agent UI** *(first slice)* - React design-session interface: conversation, definition
  and code views, streaming job logs, run results.
- **Dashboard UI** *(core flows built)* - Pipeline health, run history and lineage, data
  browser, and map view. Follows web accessibility conventions.
- **Analytical dashboards** *(core built)* - Agent-designed dashboards: React over frozen,
  parameterized SQL, compiled once and rendered in a sandboxed iframe (see
  Dashboards.md). Ship in the library like integrations; viewable with no AI
  configured.
- **AI query assistant** *(built)* - Plain-language questions answered through the documented
  API, using the same swappable model provider. Optional: the platform works without
  it.
- **Localization** *(UI built)* - Every string in the web UI goes through `ez-localize`,
  with the catalog and its tooling in the repository: `pnpm localize` re-extracts the
  strings, translates missing ones with the configured model, and exports/imports XLSX
  for human review. Operators pick their language in Settings. Server-generated text
  and agent replies are still English.
- **Deployment and compliance package** - Clean-room install path configured for the
  pilot countries, plus the open-source evidence: SPDX/SBOM checks in CI, security
  policy, documentation, and knowledge-transfer materials.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, code conventions, and how pull
requests are handled. Report vulnerabilities privately per
[SECURITY.md](SECURITY.md), never through an issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

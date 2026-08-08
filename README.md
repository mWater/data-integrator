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
cold-run-gated finish, sessions serialized to Postgres. Local accounts work:
email + password (scrypt, lockout), cookie sessions, admin/editor/viewer roles
enforced server-side, users managed via CLI. Scheduler, agent
steering/compaction/governance, the query API, and the ops dashboard are not
started.

- [Architecture.md](Architecture.md) - system design and core decisions
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
- **Integration library** *(format + first definitions)* - The machine-readable definition format and
  the definitions themselves for the target data sources (GloFAS, SPI, FPAR, DEMs,
  WorldPop, GHSL, HydroSHEDS, in-situ sensors). A standalone deliverable, independent
  of the application, including reusable skills (source and technique know-how) the
  agent loads on demand.
- **Database and migrations** *(built)* - PostgreSQL/PostGIS schema and migration
  system: destination tables, raster catalog, integrations, runs, secrets, users.
- **Web server and API** *(accounts + browse built)* - Node/TypeScript server with local accounts, RBAC, and the
  documented REST query interface over tabular data and the raster catalog. The
  contractual programmatic access path; fully functional with no AI configured.
- **Pipeline engine** *(executor built)* - Scheduler and DB-backed job queue:
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
- **Dashboard UI** - Pipeline health, run history and lineage, data browser, and map
  view. Follows web accessibility conventions.
- **Analytical dashboards** - Agent-designed dashboards: React over frozen,
  parameterized SQL, compiled once and rendered in a sandboxed iframe (see
  Dashboards.md). Ship in the library like integrations; viewable with no AI
  configured.
- **AI query assistant** - Plain-language questions answered through the documented
  API, using the same swappable model provider. Optional: the platform works without
  it.
- **Deployment and compliance package** - Clean-room install path configured for the
  pilot countries, plus the open-source evidence: SPDX/SBOM checks in CI, security
  policy, documentation, and knowledge-transfer materials.

## License

Apache 2.0

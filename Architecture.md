# Architecture

Open-source, self-hosted data integrator (Apache 2.0, DPG-aligned). Ingests multi-source
water/climate data (mostly raster), harmonizes it, stores it in PostgreSQL/PostGIS plus a
file-backed raster store, and exposes it via API, dashboard, and an AI assistant. An agentic
AI designs, tests, and maintains the ingestion pipelines.

Also the proving ground for the next-generation mWater integrator: the runner, integration
library format, and destination adapter interface are built to be imported into the mWater
platform later.

## Principles

- Single-tenant, self-hosted. Sandbox defends against accidents and misbehaving LLM code,
  not hostile co-tenants.
- Configuration-driven: new sources are integration definitions, not code changes to the core.
- The job contract is the architecture; languages are just runtime images.
- Two data planes: tabular in Postgres, raster as COGs in a file store with a Postgres catalog.
- Every heavy operation is clipped to an AOI at ingest. Global downloads are the exception.

## System overview

```
                 ┌──────────────────────────────┐
  Data sources   │  Server (Node/TypeScript)    │
  (satellite,    │  - REST API + auth (RBAC)    │      ┌─────────────────┐
   GRIB/COG,     │  - Scheduler (DB-backed)     │──────│ React dashboard │
   APIs,         │  - Agent service (AI SDK)    │      │ + AI assistant  │
   sensors)      │  - Raster tile service       │      └─────────────────┘
       │         └──────────┬───────────────────┘
       │                    │ submit job / poll / logs
       │         ┌──────────▼───────────────────┐
       └────────▶│  Job runner                  │
                 │  podman + gVisor (runsc)     │
                 │  runtime images: node, python│
                 └──────┬──────────────┬────────┘
                        │ rows + state │ COG artifacts
                 ┌──────▼──────┐  ┌────▼─────────────┐
                 │ PostgreSQL/ │  │ Raster store     │
                 │ PostGIS     │◀─│ (FS or S3-compat)│
                 │ + catalog   │  │ COG files        │
                 └─────────────┘  └──────────────────┘
```

## Execution model

Integration code runs as sandboxed container jobs. No in-process execution (the
isolated-vm model is retired).

- Runtime: podman with gVisor (runsc). Rootless, non-root user in container, read-only
  rootfs, tmpfs scratch, no capabilities.
- Limits per job: CPU, memory, disk, wall-clock timeout. Set in the integration definition,
  capped by server config.
- Network: public internet allowed; private/internal address space denied (RFC1918,
  link-local, cloud metadata endpoints), enforced by firewall rules in the job's netns.
  Replaces in-process safeFetch. An optional per-integration hostname allowlist can
  tighten egress on production deployments.
- Runtime images: `node22` and `python3.12`. Python image includes GDAL, rasterio, xarray,
  cfgrib, numpy, pyproj, geopandas. Node image includes the harness reproducing the
  existing mWater contract (fetch, parseCSV, console capture), so existing JS integrations
  run unchanged.
- JS is first-class, not legacy. Agent guidance: gridded/geospatial/large-file work is
  Python; API-to-rows glue is either.

## Job contract

One contract, language-agnostic:

- stdin: JSON `{ definition, secrets, previousState, webhookData?, params }`
- stdout: JSON `{ data?: { [tableId]: rows[] }, rasters?: RasterArtifact[], state? }`
- stderr: logs, captured and stored per run
- `/in` mount (read-only): inputs declared in the definition (catalog snapshots as COGs,
  tabular extracts)
- `/work` mount: persistent workspace, per integration (per session during design). Cache
  semantics: may be wiped at any time, correctness never depends on it, quota part of job
  limits. `previousState` remains the only authoritative incremental state.
- `/out` mount: raster artifacts (COGs) written here, referenced by path in `rasters[]`
- Exit code nonzero = failed run; stderr tail becomes the error

`RasterArtifact`: `{ layerId, bandId?, path, footprint, timestamp, metadata }`. The server
validates tabular output against destination schemas and registers raster artifacts in the
catalog. Jobs never touch Postgres or the raster store directly.

## Data storage

Tabular plane:
- Standard Postgres tables per integration destination, schema from the integration
  definition. PostGIS for geometries.

Raster plane:
- COGs in a file-backed store: local filesystem by default (low-connectivity deployments),
  S3-compatible optional. Same layout either way.
- Postgres catalog: layers → snapshots → bands, with footprints, timestamps, and
  metadata. STAC-compatible representation exposed on the API.
- Snapshots are immutable and carry a datetime or time range. Time-series layers retain
  promoted snapshots as queryable history (current = latest); current-only layers prune
  superseded snapshots. Tile and data URLs pin the snapshot, so caches never go stale.
- Source files (GRIBs, raw tiles) are working data: short retention, configured per
  integration.

## Harmonization

- Rasters are stored in EPSG:4326; tiles are warped to web mercator at render time.
- Bands declare units and nodata; values are stored in the declared units.
- Timestamps are UTC. Time-step normalization is declared in the definition.
- Tabular geometries are PostGIS, EPSG:4326.

## Integration library

The durable deliverable: machine-readable definitions, independent of this application.

Each integration: `{ id, name, source, protocol, secrets (names only), schedule, aoi,
inputs, runtime, limits, egress, destinations, stateFields, validation, code }`.
Destinations are tabular schemas and/or raster layer declarations. Inputs reference
catalog layers or tables, so derived analytics (drought indices, exposure) are ordinary
integrations. Definitions are files in a versioned library directory; the app syncs them
to the DB. Secret values never appear in the library. Code is a single self-contained
file; jobs that outgrow one file split into chained integrations via `inputs`, not
modules.

## Agent

Port of the mWater integrator agent loop (AI SDK tool calling):
- Tools: fetch samples, read/write integration, `edit_code` (exact-string replace on the
  code file), manage destinations, `run_job` (async: submit, poll status, stream logs),
  validate, finish.
- Test runs use a small AOI window to keep the design loop fast; jobs are minutes, not
  seconds, so tooling is async from day one.
- Warm runs iterate against the `/work` cache. `finish` requires one successful cold run
  of the current code (fresh workspace, null previousState), so a cache primed by
  scratch code cannot fake a pass.
- Model is a swappable provider (UAT OS-3): configured at deploy time, documented minimum
  capability profile, works with self-hostable open-weights models. Core ingest/query
  works with no model configured.

## Access layer

- REST API: documented query interface over tabular data and the raster catalog (the
  contractual "programmatic query interface").
- Dashboard (React): pipeline health, run history/lineage, data browser, map view.
  Follows web accessibility conventions.
- Raster tiles: server renders PNG tiles from COGs via GDAL CLI (gdalwarp +
  color-relief), long-cache headers, snapshot-pinned URLs. Same approach as mWater's
  RasterTilesController.
- AI assistant: plain-language query over the integrated data, same swappable model
  provider.

## Scheduling and runs

- DB-backed job queue. Scheduler enqueues per integration schedule; webhook receipts
  enqueue; agent test runs enqueue with priority.
- Runs are serialized per integration: never two concurrent runs (protects
  `previousState` and `/work`).
- Every run recorded: source, trigger, status, volume, duration, logs, artifacts.
- Definitions declare validation rules (range checks, expected cadence); violations and
  gaps flag the run, and freshness is measured against the declared cadence (FUC-3).
- Rows and snapshots carry the producing run id; definitions are versioned, so each
  datum traces to its source and transformation history (FUC-4).
- Offline behavior: runs fail cleanly on lost connectivity and backfill on resume
  (state-driven incremental fetch, as today).

## Security

- Local accounts, RBAC, hashed passwords, lockout. No default credentials.
- Secrets encrypted at rest in Postgres, injected into jobs via stdin only, never into
  images or env of the server.
- Jobs: gVisor isolation + egress policy as above. No PII in scope.
- TLS terminated by the deployer's proxy; app speaks HTTP behind it.

## Open-source compliance

- Apache 2.0 throughout. CI runs license/SPDX scans and publishes an SBOM (OS-5).
- Builds from a clean checkout with an open toolchain, verified in CI (OS-6).
- Repository carries the security policy and DPG documentation (OS-9).

## Portability to mWater

Two pieces move wholesale, consumed by mWater as dependencies rather than copies:

1. Job runner: submit/status/logs/artifacts API over podman + gVisor, exporting its own
   client types, treating job payloads as opaque. mWater deploys it as a worker fleet
   beside mwater-server; gVisor already covers multi-tenant hardening.
2. Runtime images: the harnesses define the code-facing contract, so both systems get
   identical semantics by pulling the same images. Harness contract tests live in this
   repo's CI.

Repo is a workspace to keep the seams real: `packages/runner`, `runtimes/node`,
`runtimes/python`, `apps/server`, `apps/web`.

Everything else is app-local: integration definition formats, destination adapters,
scheduling, and the agent chassis (mWater keeps AgentSessionController; tool set and
prompts port with adaptation).

Cutover test: mwater-server swaps executeScript() for the runner client, re-homes
existing JS integrations onto the `node22` image, they pass unchanged, and isolated-vm
is deleted.

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
  link-local, cloud metadata endpoints), enforced by a proxy in the job's netns.
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
- Postgres catalog: layers → snapshots → bands, with footprints and metadata.
  STAC-compatible representation exposed on the API.
- Snapshots are immutable. New data is a new snapshot; promotion flips the layer's current
  pointer. Tile and data URLs pin the snapshot, so caches never go stale.
- Source files (GRIBs, raw tiles) are working data: short retention, configured per
  integration.

## Integration library

The durable deliverable: machine-readable definitions, independent of this application.

Each integration: `{ id, name, source, protocol, auth/secrets, schedule, aoi, runtime,
limits, egress, destinations, stateFields, code }`. Destinations are tabular schemas
and/or raster layer declarations. Definitions are files in a versioned library directory;
the app syncs them to the DB.

## Agent

Port of the mWater integrator agent loop (AI SDK tool calling):
- Tools: fetch samples, read/write integration, manage destinations, `run_job` (async:
  submit, poll status, stream logs), validate, finish.
- Test runs use a small AOI window to keep the design loop fast; jobs are minutes, not
  seconds, so tooling is async from day one.
- Model is a swappable provider (UAT OS-3): configured at deploy time, documented minimum
  capability profile, works with self-hostable open-weights models. Core ingest/query
  works with no model configured.

## Access layer

- REST API: documented query interface over tabular data and the raster catalog (the
  contractual "programmatic query interface").
- Dashboard (React): pipeline health, run history/lineage, data browser, map view.
- Raster tiles: server renders PNG tiles from COGs via GDAL CLI (gdalwarp +
  color-relief), long-cache headers, snapshot-pinned URLs. Same approach as mWater's
  RasterTilesController.
- AI assistant: plain-language query over the integrated data, same swappable model
  provider.

## Scheduling and runs

- DB-backed job queue. Scheduler enqueues per integration schedule; webhook receipts
  enqueue; agent test runs enqueue with priority.
- Every run recorded: source, trigger, status, volume, duration, logs, artifacts.
  This is the lineage/monitoring story (FUC-3/FUC-4).
- Offline behavior: runs fail cleanly on lost connectivity and backfill on resume
  (state-driven incremental fetch, as today).

## Security

- Local accounts, RBAC, hashed passwords, lockout. No default credentials.
- Secrets encrypted at rest in Postgres, injected into jobs via stdin only, never into
  images or env of the server.
- Jobs: gVisor isolation + egress policy as above. No PII in scope.
- TLS terminated by the deployer's proxy; app speaks HTTP behind it.

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

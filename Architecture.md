# Architecture

mWater Pathfinder: open-source, self-hosted data integrator (Apache 2.0, DPG-aligned). Ingests multi-source
water/climate data (mostly raster), harmonizes it, stores it in PostgreSQL/PostGIS plus a
file-backed raster store, and exposes it via API, dashboard, and Explore, an AI query agent. An agentic
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
   APIs,         │  - Agent service (AI SDK)    │      │ + Explore agent │
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

- Runtime: podman with gVisor (runsc). Rootless (container root maps to an unprivileged
  host user), read-only rootfs, tmpfs scratch, no capabilities.
- Limits per job: CPU, memory, disk, wall-clock timeout. Set in the integration definition,
  capped by server config.
- Network: public internet allowed; private/internal address space denied (RFC1918,
  link-local, cloud metadata endpoints), enforced by firewall rules in the job's netns.
  Replaces in-process safeFetch. A hostname allowlist would require an egress proxy;
  not designed, revisit if a deployment demands it.
- Runtime images: `node` and `python`, standard unrestricted runtimes. Python
  includes the geospatial stack (GDAL, rasterio, xarray, netCDF4/h5netcdf/h5py, cfgrib,
  numpy, pyproj, geopandas); Node has real fetch, fs, crypto, and streams. Libraries are
  a curated set baked into each image, pinned by digest; no package installs at run time.
  The GDAL base is the small build with no netCDF/HDF driver, so those formats are read
  through xarray/h5py rather than GDAL.
- Both languages are first-class. Agent guidance: gridded/geospatial/large-file work is
  Python; API-to-rows glue is either.

## Job contract

One contract, language-agnostic:

- stdin: JSON `{ definition, secrets, previousState, webhookData?, params, catalog? }`;
  webhookData is all pending events, batched oldest first; catalog lists, per declared
  raster destination, the snapshots already promoted (timestamp, period end, source
  count), so code decides for itself what still needs producing and honours
  `params.force` for a rerun. Completion policy lives in the integration, never in the
  scheduler
- stdout: JSON `{ data?: { [tableId]: rows[] }, tables?: TableArtifact[],
  rasters?: RasterArtifact[], state? }`. stdout is capped (10 MB), so `data` is for
  result sets that comfortably fit; larger tables travel as files in `tables[]`
- stderr: logs, captured and stored per run
- `/in` mount (read-only): inputs declared in the definition (catalog snapshots as COGs,
  tabular extracts), resolved and materialized by the server at launch and described to
  the code by `/in/manifest.json`. Resolved snapshot ids are recorded on the run for
  lineage and reproducibility.
- `/work` mount: persistent workspace, per integration (per session during design). Cache
  semantics: may be wiped at any time, correctness never depends on it, quota part of job
  limits. `previousState` remains the only authoritative incremental state. Workspaces
  are never shared: data used by multiple integrations is ingested once as a catalog
  layer and consumed via `inputs`.
- `/out` mount: artifacts written here, referenced by path: raster snapshots (COGs) in
  `rasters[]`, table files (GeoJSON/FlatGeobuf/GeoPackage/CSV) in `tables[]`
- Exit code nonzero = failed run; stderr tail becomes the error

The harness in each image maps the payload onto a single entrypoint, so integration code
is a plain module with no magic globals:

- Node: `export default async function run({ secrets, previousState, webhookData, params, catalog })`
- Python: `def run(ctx)` with the same fields

The contract types (`JobPayload`, `RunResult`, `RasterArtifact`, `TableArtifact`,
`CatalogSnapshot`) ship in the runner package, since the harness is what implements them;
the definitions package re-exports them.

The return value becomes stdout. The sandbox is the container, not the language.

`RasterArtifact`: `{ layerId, path | sources, timestamp, timestampEnd?, footprint?, crs?,
metadata? }`. A snapshot is one file (`path`) or a set of files (`sources: [{ path,
footprint? }]`) mosaicked at read time, for tiled products too large to merge. `sources:
[]` publishes an empty snapshot: nothing observed at that time, superseding the previous
one, which is distinct from omitting the artifact (no update). The server validates
tabular output against destination schemas and registers raster artifacts in the catalog.
Jobs never touch Postgres or the raster store directly.

`TableArtifact`: `{ tableId, path, format? }`, format inferred from the extension. The
server loads the file into a staging table with ogr2ogr, then applies it to the
destination inside the commit transaction, so a file load has the same atomicity as
inline rows: `replace` still builds a new table and swaps. Declared columns remain the
contract, matched to file fields by name and cast to the declared types; the file's
geometry feeds a declared geometry column whatever the driver named it, and is
reprojected to EPSG:4326 when it carries another CRS. One layer per file, and a table
arrives either inline or as a file, never both.

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
  promoted snapshots as queryable history (current = newest whose time has arrived, so
  projections roll over on schedule); current-only layers prune
  superseded snapshots. Tile and data URLs pin the snapshot, so caches never go stale.
- Source files (GRIBs, raw tiles) are working data: short retention, configured per
  integration.

## Harmonization

- Rasters keep their source grid and CRS (no resampling at ingest); the catalog
  records CRS per snapshot. Tiles are warped to web mercator at render time.
- Promoted snapshots are also registered as tiled out-db PostGIS rasters
  (data.rasters) referencing the COGs, so SQL composes raster values with
  vector rows — per-feature sampling, buffered zonal statistics — without
  pixels entering the database. Best-effort: requires the DB server to read
  the store (true in the reference deployment); everything else works without it.
- Bands declare units and nodata; values are stored in the declared units.
- Timestamps are UTC. Time-step normalization is declared in the definition.
- Tabular geometries are PostGIS, EPSG:4326.

## Integration library

The durable deliverable: machine-readable definitions, independent of this application.

Each integration: `{ id, name, source, trigger, secrets (names only), aoi, inputs,
runtime, limits, destinations, validation, code, contract }`. Destinations are tabular
schemas and/or raster layer declarations. Inputs reference catalog layers or tables, so
derived analytics (drought indices, exposure) are ordinary integrations. Library definitions
are starting values: installing copies them into the integration's definition, which
is from then on the single specification — there is no separate override layer, so
the agent and the UI edit the same object and every change archives a new attributed
version. Updating from the library carries the deployment-owned fields (aoi, trigger,
limits) over from the installed definition. AOI is tri-state: an explicit box clips
to it, explicit null means the source's full extent, and omitting it inherits the
deployment default AOI at run time. The box is a download window, not the country:
the deployment's default AOI also becomes a shape (`data.aoi`, the selected countries'
land outlines from bundled Natural Earth 1:10m with lakes removed, cut to the box),
and `data.aoi_stats()` gives area-weighted statistics of a raster layer over it, with
coarse pixels weighted by the part inside the boundary, fine ones by their area
at their latitude, and coverage reported. Every
agent is told that a share "of the country" comes from that, never from the
envelope. Maps follow the same tri-state per layer: a layer whose integration inherits
the default is drawn clipped to that shape, one with its own countries to theirs, and
one with an explicit box or full extent unclipped (`raster_layers.mask_geom`, applied in
the tile renderer only, `?mask=0` to see the surroundings). Definitions are files in a versioned library
directory; the app syncs them to the DB. Secret values never appear in the library. Code is a single self-contained
file; jobs that outgrow one file split into chained integrations via `inputs`, not
modules.

## Agent

Port of the mWater integrator agent loop (AI SDK tool calling):
- Tools: fetch samples, read/write integration, `edit_code` (exact-string replace on the
  code file), manage destinations, `run_job` (async: submit, poll status, stream logs),
  validate, finish.
- Test runs use a small AOI window to keep the design loop fast; jobs are minutes, not
  seconds, so tooling is async from day one.
- Skills (`library/skills/<id>/SKILL.md`): source and technique know-how. The agent's
  system prompt carries an index of one-liners; read_skill loads full text on demand.
  Prose only, never executed; the library repo's review is the trust boundary.
- Warm runs iterate against the `/work` cache. `finish` requires one successful cold run
  of the current code (fresh workspace, null previousState), so a cache primed by
  scratch code cannot fake a pass.
- Model is a swappable provider (UAT OS-3): configured at deploy time, documented minimum
  capability profile, works with self-hostable open-weights models. Core ingest/query
  works with no model configured.

## Access layer

- REST API: documented query interface over tabular data and the raster catalog (the
  contractual "programmatic query interface").
- UI delivery: React SPA (apps/ui) built to static files and served by the server
  itself (same origin: no CORS, no second deploy target). Design sessions stream
  over SSE; user messages are plain POSTs.
- Dashboard (React): pipeline health, run history/lineage, data browser, map view.
  Follows web accessibility conventions.
- Analytical dashboards: agent-designed React over design-time-frozen SQL, rendered
  in a sandboxed iframe. See Dashboards.md.
- Raster tiles: server renders PNG tiles from COGs via GDAL CLI (gdalwarp +
  color-relief), long-cache headers, snapshot-pinned URLs. Same approach as mWater's
  RasterTilesController.
- Explore (AI agent): plain-language query over the integrated data, same swappable model
  provider.

## Scheduling and runs

- DB-backed job queue. Scheduler enqueues per integration schedule; webhook receipts
  enqueue; agent test runs enqueue with priority.
- Derived integrations are scheduled like everything else; the server skips a run when
  resolved inputs are unchanged since the last success, or unresolvable (flagged
  skip). Definitions whose inputs intersect their own destinations are rejected.
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
- Credentials are requested inside the design session: the designer's `request_secrets`
  tool declares the names and pauses, a card in the session lets an admin save (or copy
  from another integration) each value against the draft, an optional agent-written check
  snippet verifies it in the sandbox, and the session resumes with a names-only message.
  `list_secrets` exposes stored names (never values) so agents reuse existing credentials.
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

Cutover of existing mWater integrations: see mWater Migration.md.

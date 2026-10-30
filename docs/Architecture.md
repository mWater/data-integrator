# Architecture

mWater Data Integrator is an open-source (Apache 2.0), self-hosted data integrator. It
ingests water and climate data (mostly raster) from many sources, harmonizes it, stores
it in PostgreSQL/PostGIS plus a file-backed raster store, and serves it through a REST
and STAC API, a map and data browser, dashboards, and Explore, a conversational query
agent. An AI designer agent builds, tests and maintains the ingestion pipelines.

The job runner (`packages/runner`) and the runtime images are self-contained: they
implement the job contract below and know nothing about the rest of the application
(see [the runner README](../packages/runner/README.md)).

## Principles

- Single-tenant, self-hosted. The sandbox defends against accidents and misbehaving
  LLM-written code, not hostile co-tenants.
- Configuration-driven: a new source is an integration definition, not a change to the
  core.
- The job contract is the architecture; languages are runtime images.
- Two data planes: tabular in Postgres, raster as COGs in a file store with a Postgres
  catalog.
- Heavy operations are clipped to an area of interest (AOI) at ingest. Global downloads
  are the exception.

## System overview

```
                 ┌──────────────────────────────┐
  Data sources   │  Server (Node/TypeScript)    │      ┌─────────────────┐
  (satellite,    │  - REST + STAC API, RBAC     │──────│ React UI        │
   GRIB/COG,     │  - Scheduler (DB-backed)     │      │ + Explore agent │
   APIs,         │  - Agents (AI SDK)           │      └─────────────────┘
   sensors)      │  - Raster tile service       │
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
                 │ PostGIS     │◀─│ (filesystem)     │
                 │ + catalog   │  │ COG files        │
                 └─────────────┘  └──────────────────┘
```

## Execution model

Integration code runs only as sandboxed container jobs.

- Runtime: podman with gVisor (runsc). Rootless (container root maps to an unprivileged
  host user), read-only root filesystem, a per-run `/tmp` on disk, all capabilities dropped,
  no-new-privileges, a pids limit.
- Limits per job: CPU, memory, wall-clock timeout and `/work` and `/tmp` quotas. The definition's
  `limits` requests them; the deployment ceilings `JOB_MAX_CPUS`, `JOB_MAX_MEMORY_MB`
  and `JOB_MAX_TIMEOUT_MIN` lower any request above them, and each lowered value is
  noted in the run log. Unset values take the runner defaults (2 CPUs, 2048 MB,
  15 minutes).
- `/work` quota: `WORK_QUOTA_MB` caps `limits.workDiskMb` and is the quota when the
  definition sets none. A run whose `/work` is already over quota does not start, and
  the runner kills a job that grows past it. `MIN_FREE_DISK_MB` is a free-space floor on
  the work root and raster store, checked before and during each run.
- `/tmp` quota: each run and snippet gets an empty directory under `<work root>/.tmp`
  mounted at `/tmp` and removed when the job ends, so intermediates never persist in
  `/work` or count against memory. `TMP_QUOTA_MB` caps `limits.tmpDiskMb` and is the
  quota when the definition sets none; the runner kills a job that grows past it.
  Housekeeping removes directories a crashed process left behind after two days.
- Host memory: `SANDBOX_MEMORY_MB` is the total memory admitted runs may hold at once.
  Each run reserves its memory limit before its container starts and waits while the
  budget is full.
- Network: public internet allowed; private address space denied (RFC 1918,
  link-local including cloud metadata endpoints, carrier-grade NAT), enforced by
  nftables rules in the jobs' network namespace. There is no hostname allowlist.
- Runtime images: `node` (Node 22) and `python` (on the GDAL small image). Python carries
  the geospatial stack (GDAL, rasterio, xarray, netCDF4/h5netcdf/h5py, cfgrib, numpy,
  scipy, pyproj, geopandas, pandas, spreadsheet readers, cdsapi, ecmwf-opendata); Node
  has fetch, fs, crypto and streams plus a few parsing libraries. Libraries are baked
  into each image; nothing is installed at run time. The GDAL build has no netCDF/HDF
  driver, so those formats are read through xarray/h5py.
- Both languages are first-class. Agent guidance: gridded, geospatial and large-file
  work is Python; API-to-rows glue is either.

## Job contract

One contract, language-agnostic:

- stdin: JSON `{ definition, secrets, previousState, webhookData?, params, catalog? }`.
  `webhookData` is every pending webhook event, oldest first. `catalog` lists, per
  declared raster destination, the most recent promoted snapshots (timestamp, period
  end, source count), so code decides for itself what still needs producing.
  Completion policy lives in the integration, never in the scheduler. `params`
  (`ctx.params`) carries the definition's declared `settings`, each at the deployment's
  value from `settingValues` or its default, and nothing else; the run records them in
  `runs.inputs`. A rebuild (trigger `rebuild`, from the integration page or `cli.js run
  <id> --rebuild`) runs cold: `previousState` null and an empty `/work`.
- stdout: JSON `{ data?: { [tableId]: rows[] }, tables?: TableArtifact[],
  rasters?: RasterArtifact[], state? }`. stdout is capped at 10 MB, so `data` is for
  result sets that fit comfortably; larger tables travel as files in `tables[]`.
- stderr: logs, captured per run (the stored log keeps the last 256 KB).
- `/in` (read-only): inputs declared in the definition (catalog snapshots as COGs,
  tabular extracts) and uploaded file versions (`/in/files/<slot><ext>`, see
  [Integration Files](Integration%20Files.md)), materialized by the server at launch
  and described by `/in/manifest.json`. The resolved snapshot and file version ids are
  recorded on the run for lineage.
- `/work`: persistent workspace per integration (per session during design). A cache:
  it may be wiped at any time and correctness never depends on it. `previousState` is
  the only authoritative incremental state. Workspaces are never shared: data used by
  several integrations is ingested once as a catalog layer and consumed via `inputs`.
- `/out`: artifacts written here and referenced by path: raster snapshots (COGs) in
  `rasters[]`, table files (GeoJSON, FlatGeobuf, GeoPackage, CSV) in `tables[]`.
- Nonzero exit = failed run; the stderr tail becomes the error.

The harness in each image maps the payload onto one entrypoint, so integration code is
a plain module with no magic globals:

- Node: `export default async function run({ definition, secrets, previousState, webhookData, params, catalog })`
- Python: `def run(ctx)` with the same fields

The return value becomes stdout. The sandbox is the container, not the language.

The runner's payload also supports `mode: "snippet"` (run a code string and return raw
stdout), `code` (entrypoint source in place of `definition.code`), and multi-file jobs
(`files` plus `entry`). The application uses snippet mode for design-session
exploration and single-file code for integrations. The contract types (`JobPayload`,
`RunResult`, `RasterArtifact`, `TableArtifact`, `CatalogSnapshot`) ship in the runner
package; `packages/definitions` re-exports them.

`RasterArtifact`: `{ layerId, path | sources, timestamp, timestampEnd?, footprint?, crs?,
metadata? }`. A snapshot is one file (`path`) or a set of files (`sources: [{ path,
footprint? }]`) mosaicked at read time, for tiled products too large to merge.
`sources: []` publishes an empty snapshot: nothing observed at that time, superseding
the previous one, which differs from omitting the artifact (no update). All files of a
snapshot share one CRS.

`TableArtifact`: `{ tableId, path, format? }`, format inferred from the extension. The
server loads the file into a staging table with ogr2ogr, then applies it to the
destination inside the commit transaction, so a file load has the same atomicity as
inline rows (`replace` still builds a new table and swaps). Declared columns remain the
contract, matched to file fields by name and cast to the declared types; the file's
geometry feeds the declared geometry column whatever the driver named it, reprojected to
EPSG:4326 when needed. One layer per file, and a table arrives either inline or as a
file, never both.

The server validates output against the declared destinations and registers rasters
in the catalog. Jobs never touch Postgres or the raster store directly.

## Data storage

Tabular plane: one Postgres table per table destination in the `data` schema, schema
from the definition, PostGIS for geometries. See [Database](Database.md).

Raster plane:

- COGs in a file-backed store, a plain directory (`RASTER_STORE_PATH`), laid out
  `<layerId>/<snapshotId>/<ordinal>.tif`. Object storage can sit behind it as a
  filesystem mount, provided the database server can read the same path (below).
- Postgres catalog: layers -> snapshots -> sources (`raster_sources`, one row per
  file), with footprints, timestamps and CRS. Band specs are jsonb on the layer, band
  order on the snapshot.
- Snapshots are immutable and carry a datetime or a time range. Time-series layers keep
  promoted snapshots as history (optionally trimmed to `retention.days`); current-only
  layers supersede the previous snapshot. A layer's current snapshot is the newest one
  whose time has arrived, so projection layers roll over on schedule without a run.
  Tile and download URLs pin the snapshot, so caches never go stale.
- Source downloads (GRIBs, raw tiles) are working data in `/work`, bounded by the
  quota and wiped by any cold run. Intermediates built from them each run (unpacked
  archives, VRTs, GeoTIFFs before COG conversion) go in `/tmp`.

## Harmonization

- Rasters keep their source grid and CRS (no resampling at ingest); the catalog records
  CRS and approximate cell size per snapshot. Tiles are warped to web mercator at render
  time.
- Promoted snapshots are also registered as tiled out-db PostGIS rasters
  (`data.rasters`) referencing the COGs, so SQL composes raster values with vector rows
  (per-feature sampling, buffered zonal statistics) without pixels entering the
  database. Registration is required: it happens inside the run's commit transaction,
  and a snapshot the database cannot register (CRS unknown to `spatial_ref_sys`, file
  unreadable by the Postgres server) fails the run. Design-session runs validate
  registration without writing it.
- Bands declare units and nodata.
- Timestamps are UTC. Tabular geometries are PostGIS, EPSG:4326.

## Integration library

The durable deliverable: machine-readable definitions, independent of this application
(format: [Integration Library Specification](spec/Integration%20Library%20Specification.md)).

Each integration: `{ id, name, description?, source?, trigger, secrets? (names only),
aoi?, inputs?, files?, runtime, limits?, destinations, validation?, code, contract }`.
`files` maps slot ids to slot specs `{ description?, accept? }`. Destinations are table
schemas and/or raster layer declarations. Inputs reference catalog layers or tables, so
derived analytics (drought indices, exposure) are ordinary integrations; a definition
whose inputs reference its own destinations is rejected. Code is one self-contained
file; jobs that outgrow it split into chained integrations via `inputs`.

Library entries live under `library/integrations/<id>/` (`definition.json` plus one
code file). Installing an entry (Library page or `cli.js library-install`) copies it
into the integration's definition, which is from then on the single specification:
there is no override layer, so the agent and the UI edit the same object and every
change archives a new attributed version. Updating from the library carries the
deployment-owned fields (`aoi`, `trigger`, `limits`, and the `settingValues` the new
definition still accepts) over from the installed definition.
Secret values never appear in the library.

AOI is tri-state: an explicit box clips to it, explicit `null` means the source's full
extent, and omitting it inherits the deployment default AOI at run time. Export keeps
an explicit `aoi: null` and strips a concrete AOI, so the importing deployment's default
applies. The box is a download window, not the country: the deployment default also
becomes a shape (`data.aoi`: the selected countries' land outlines from bundled Natural
Earth 1:10m with lakes removed, cut to the box), and `data.aoi_stats()` gives
area-weighted statistics of a raster layer over it, reporting coverage. The Explore and
dashboard agents are told that a share "of the country" comes from that function, never
from the envelope. Maps follow the same tri-state per layer: a layer whose integration
inherits the default is drawn clipped to that shape, one with its own countries to
theirs, and one with an explicit box or full extent unclipped
(`raster_layers.mask_geom`, applied by the tile renderer only; `?mask=0` shows the
surroundings).

## Validation and freshness

A definition's `validation` block declares `ranges` (min/max per table column or raster
band) and `expectedCadence` (ISO 8601 duration). After each successful job:

- Range rules on numeric table columns are checked exactly over the rows the run wrote
  (`_run_id`), inside the commit transaction. Enum columns are checked for values
  outside their declared codes.
- Range rules on raster bands are checked against approximate GDAL statistics of the
  stored files.
- Findings are stored in `runs.flags` and appended to the run log. They never reject
  data: a source that legitimately moves outside a declared range keeps loading.
- Flags show in the run history, on the home page (latest successful run flagged), and
  in the designer's `run_integration` result.
- `expectedCadence` raises an "overdue" alert on the home page when an enabled
  integration has no successful run within twice the cadence.

## Scheduling and runs

- DB-backed queue in `app.runs`. The scheduler enqueues cron runs for enabled, ready
  integrations once per UTC minute; webhook receipts enqueue a run (after the optional
  `webhookDelaySeconds` batch window). Manual runs (API, `cli.js run`) skip the queue:
  they are inserted as running and executed at once by the calling process, and are
  refused while another run is running or queued. A run pinning uploaded file versions
  queues behind a run in progress instead. Integrations with a file slot that has never
  been filled are not enqueued.
- Design-session runs belong to the session, not the queue: the designer executes them
  in-process against the session's scratch area.
- Partial unique indexes serialize runs: at most one running and one queued run per
  integration (and per design session), which protects `previousState` and `/work`.
  Repeated triggers coalesce into the one queued run.
- Two scheduler workers per server process claim due queued runs (priority, then
  oldest `scheduled_at` first) under a lease: an attempt token plus a heartbeat. A reaper fails runs
  whose heartbeat is stale; the attempt token on the heartbeat and on the success
  commit stops a stale worker from committing after a reclaim. Job containers left by
  a previous process are removed at scheduler start.
- Every Postgres effect of a run commits in one transaction (rows, snapshots, raster
  registration, webhook consumption, state, file slot versions, status). A failed run
  commits only its own run record.
- Every run is recorded: trigger, status, timings, stats, flags, error, log, inputs
  read (AOI, snapshot ids, file versions) and the definition version. Rows and
  snapshots carry the producing run id, so each datum traces to its source and
  definition.
- Offline behaviour: a run fails cleanly when the network is gone; incremental
  integrations catch up from `previousState` on the next run.

## Agents

Three agent kinds share one harness: the designer (builds integrations), Explore
(answers questions over the data) and the dashboard agent (builds dashboards, see
[Dashboards](Dashboards.md)). Every agent needs an AI model; core ingest, query, maps
and installed dashboards work with none configured, and the agent features are absent
until one is.

### Harness

The loop is hand-rolled on the AI SDK (`apps/server/src/agent`):

- `AgentSessionController` owns the loop and storage. `AgentImplementation` (one per
  kind) supplies the model, system prompt, tool schemas, tool execution and step caps.
- One step = one `generateText` call plus execution of the tool calls it returned. The
  whole session (messages, client state, usage) is serialized to
  `app.agent_sessions` after every step, so any server process can resume any session;
  there is no process affinity. A model or provider failure pauses the session with
  the error recorded, resumable from the UI.
- Tool outcome contract: a tool returns `{ result, state?, finished?, pause? }`.
  `result` is the text the model sees (capped at 16,000 characters); `state` replaces
  the session's client state, which the UI renders; `finished` ends the task; `pause`
  stops the loop for user input.
- Ask-user: `ask_user` (and `request_secrets`) pause the session; the UI shows the
  question with options, and the answer arrives as the next user message. A reply with
  no tool calls also pauses.
- Steering: messages typed while a loop runs queue and are injected at the next step
  boundary, before the next model call.
- Stop: a stop request takes effect at the next step boundary; if the model has just
  asked for tools, they are cancelled with synthetic results so the transcript stays
  valid.
- Events (assistant text, tool start/end, job log lines) stream to the browser over SSE;
  user messages are plain POSTs.
- Spend: daily token caps per user and per deployment (input plus output tokens, UTC
  days, counted in `app.ai_usage`) are checked before every model call. Defaults are 5M
  per user and 25M per deployment; admins change them in Settings. Each kind also caps
  model calls per session (and Explore per turn).

Why a hand-rolled loop on the AI SDK: the provider must be swappable down to
self-hosted open-weights models, and the AI SDK's provider abstraction gives that
without tying the loop to one vendor. The loop is a few hundred lines the project owns;
the hard parts (tool semantics, client state, the cold-run gate, spend caps) are
application code either way, and the available third-party harnesses are young and
assume a long-lived process owns each session, where here the database does.

The provider, model and API key are set at runtime by an admin in Settings
(OpenRouter, Anthropic, or any OpenAI-compatible endpoint, including a self-hosted
one). The key is stored encrypted under `INTEGRATOR_SECRET_KEY`, and a change applies
without a restart. Hosted providers require each user's one-time acknowledgement that
AI features send data to the provider.

### Designer

Builds and maintains one integration per session. Tools: `write_definition`,
`get_definition`, `edit_code` (exact-string replace on the code), `run_snippet`
(throwaway code in the sandbox, nothing committed), `run_integration` (a real run of
the draft; `cold: true` wipes `/work` and nulls `previousState`), `query_table`
(read-only SELECT, 50 rows), `read_skill`, `request_secrets`, `list_secrets`,
`search_library`, `lookup_country`, `ask_user`, `finish`.

- Scratch area: design runs write to a `draft_<session>` schema and session-owned
  preview layers, with `/work` keyed by session. Installed integrations are never
  touched mid-design.
- A valid draft becomes a `draft`-status integration row, so credentials and file
  uploads have something to attach to.
- `finish` requires a successful cold run of the exact current definition (and of the
  file versions it reads), so a cache primed by scratch code cannot fake a pass. It
  installs the definition as `ready`, discards the scratch area, and on a fresh install
  starts the first production run.
- Skills (`library/skills/<id>/SKILL.md`): source and technique know-how. The system
  prompt carries a one-line index; `read_skill` loads the full text on demand. Prose
  only, never executed; library review is the trust boundary.
- Thrash guard: after 3 consecutive runs failing with the same error the agent is told
  to stop and ask; after 5 the session pauses.

### Explore

The query assistant (`agent_sessions.kind = 'assistant'`): plain-language questions over
the integrated data. Read-only by construction, so it is open to every role including
viewers. It never fetches sources or runs jobs; for data that is not ingested it points
at a Library entry or a pre-filled design session.

- Tools: `list_schema` (tables with columns and units, raster layers with bands, the
  deployment AOI), `query` (investigate; results stay with the agent), `show_table`,
  `show_chart`, `show_map`, `lookup_country`, `search_library`.
- SQL runs under the same guards as dashboard queries: a read-only transaction as the
  `sql_engine` role (SELECT on `data` only), 15 s statement timeout, search path
  `data, public`, UTC session time zone. A result over 1,000 rows or 2 MB is rejected,
  not truncated. The full raster x vector space is available through `data.rasters`
  and `data.aoi_stats()`.
- Answers are markdown plus typed blocks rendered by the UI: a table (with CSV
  download), a chart (the kit `Chart` declarative spec: line, area, bar, pie, scatter,
  category or time axis) or a map (catalog raster layers, optionally at a date, plus
  GeoJSON overlays from result rows). Every block carries its SQL, visible on expand.
- Sessions are persisted and listed like other sessions.

## Credentials

Secret values never enter the transcript, the model, the definition or the library.
They are stored per integration in `app.integration_secrets`, AES-256-GCM under
`INTEGRATOR_SECRET_KEY`, and reach a job only in its stdin payload, never in
environment variables or images. Only the owning integration's values are visible to
its runs.

In a design session:

- The designer calls `request_secrets` with `{ name, purpose, help?, copyFrom?, check? }`
  per credential. The names are declared on the draft and the session pauses on a
  credentials card.
- Admins save each value from the card (or copy it from another integration holding
  the same name, server side). Editors see what is needed, a link to the integration's
  credentials page for an admin, and a Continue button.
- An optional `check` snippet (one cheap authenticated call) runs in the sandbox after
  a save and shows verified or rejected with its output. The session resumes with a
  names-only message once every value is saved and no check was rejected.
- `list_secrets` shows the agent stored names and their owning integrations, never
  values, so it reuses an existing credential instead of declaring a new name.
- `run_integration` and `run_snippet` refuse up front when a declared secret is
  missing, pointing the agent at `request_secrets`.
- The home page lists enabled integrations (drafts included) with declared secrets not
  yet stored, linking to the paused session that asked for them.

Secret values (6 characters or longer) are masked as `[secret:<name>]` in run logs, run
errors, live log streams and snippet output. Only the literal value is masked, not
encodings of it.

## Access layer

- REST API over tabular data, the raster catalog, integrations, files, settings and
  sessions; see [API](API.md). Bearer personal access tokens or a session cookie.
- STAC API at `/api/stac` (signed-in users): landing page, conformance, one Collection
  per installed raster layer, one Item per promoted non-empty snapshot with its COG
  files as assets (the snapshot download URLs). Item search supports `datetime`,
  `bbox` and `limit` (default 100, max 1000) with token paging.
- UI: React SPA (`apps/ui`) built to static files and served by the server itself (same
  origin, no CORS, no second deploy target): home page with health and alerts, run
  history and lineage, data browser, map, dashboards, design sessions, Explore,
  settings.
- Dashboards: agent-designed React over SQL frozen at save time, rendered in a sandboxed
  iframe; see [Dashboards](Dashboards.md).
- Raster tiles: rendered on demand from the COGs with GDAL (gdalbuildvrt for
  multi-file snapshots, gdalwarp, gdaldem color-relief), cached on disk under
  `TILE_CACHE_MB`, snapshot-pinned URLs with long-lived cache headers.

## Housekeeping and retention

- Snapshot retention (`retention.ts`) runs after every scheduler run, hourly, and on
  `cli.js prune-snapshots`: it deletes superseded snapshots and time-series snapshots
  past their layer's `retention_days`, with their files and cached tiles. A layer's
  current snapshot is never deleted.
- Daily housekeeping (`housekeeping.ts`) removes expired sign-in sessions, consumed
  webhook events after 30 days, run logs after 90 days (the run rows stay), the scratch
  areas of design sessions idle for 30 days, and raster store snapshot directories no
  snapshot row refers to once they are a day old.
- At boot the server removes file-store leftovers (`.tmp`, `.jobs`, orphaned version
  files) older than an hour.

## Security

- Local accounts with roles (admin, editor, viewer), scrypt password hashes, lockout
  after repeated failures, no default credentials.
- Optional account policy (Settings, admins): password expiry, enforced at sign-in
  with a forced change, and disabling of accounts inactive for N days, by the daily
  housekeeping sweep. Both are off by default, following NIST SP 800-63B; the sweep
  never disables the last active admin.
- Security event log: JSON lines (`"type": "security"`) on the service log for
  sign-in outcomes, every API write with its actor and outcome, inactivity
  disabling and run outcomes (Deployment.md lists the events).
- Credentials as above. Jobs run under gVisor with the egress policy above.
- The `app`/`data` schema split is the query boundary: user-facing SQL (dashboards,
  Explore) runs as `sql_engine`, which has SELECT on `data` only.
- TLS is terminated by the deployer's proxy; the app speaks HTTP behind it.
- See [Deployment](Deployment.md) and the repository's `SECURITY.md`.

## Open-source compliance

- Apache 2.0 throughout. CI checks every production dependency's license against an
  OSI-approved SPDX allowlist and publishes a CycloneDX SBOM.
- Builds and tests from a clean checkout with an open toolchain, verified in CI.
- Proprietary dependencies, all optional, are declared in the
  [Exceptions Register](Exceptions%20Register.md).

## Testing

- The server, the runner, the kit and both runtime images have `node:test` suites, run
  together by `pnpm test` and in CI on every push and pull request
  (`.github/workflows/ci.yml`). `packages/definitions` (types only) and `apps/ui` have
  none.
- Server tests (`apps/server/test`) are integration tests against a real database: each
  file starts an ephemeral PostGIS container (or uses `TEST_DATABASE_URL`), applies the
  migrations, and drives the HTTP API, the scheduler and the executor. Executor tests
  run real jobs in the sandbox under gVisor.
- The runner (`packages/runner`), the dashboard kit (`packages/kit`) and the two
  runtime images (`runtimes/*`) have their own suites; the runtime suites exercise the
  job contract inside the built images.
- Refusals are tested alongside successes: role checks, lockout, sandbox limits,
  blocked egress, invalid definitions.
- The compliance job checks dependency licenses and produces the SBOM on the same
  triggers.

## Localization

- The interface ships in English, French, Portuguese, Spanish, Malagasy and Swahili.
  An admin chooses which are offered (Settings, Languages); each user picks one.
- Strings use `ez-localize` tagged templates (`` T`Save` ``) and live in one catalog,
  `apps/ui/src/localizations.json`.
- `pnpm localize` in `apps/ui` extracts new strings; `--translate <locales>` fills
  them by machine translation with the glossary in `apps/ui/scripts/translation-context.md`;
  `--export <locale>` and `--import <locale> --file <xlsx>` round-trip a spreadsheet
  for human translators. Adding a language is a new locale in the catalog, translated
  this way.
- Library entries carry localized names and descriptions (Integration Library
  Specification, section 2.2). When an admin adds a language and an AI model is
  configured, the deployment translates its installed catalog in the background.
- Server-generated messages and AI replies are in English, or in the language the user
  writes in for the AI features.

## Accessibility

The interface follows established web accessibility conventions at a level suited to
a proof of concept; it has not had a formal WCAG conformance audit.

- Semantic structure: landmarks (`main`, `nav`, `header`), native buttons, links and
  form controls, with labels or `aria-label` where a control has no visible text.
- Keyboard: controls are reachable and operable by keyboard, with a visible focus
  outline, and dialogs close with Escape; panning and zooming maps needs a pointer.
- Status and errors are announced (`role="status"`, `role="alert"`).
- Light and dark themes, following the system preference by default; animation is
  reduced when the system asks for it.

## Repository layout

A pnpm workspace:

- `packages/runner`: the job runner (podman + gVisor, egress policy, limits) and the job
  contract types.
- `packages/definitions`: integration definition types and shared helpers.
- `packages/kit`: the dashboard component kit and its runtime assets.
- `runtimes/node`, `runtimes/python`: runtime images and their harnesses.
- `apps/server`: API, scheduler, executor, agents, migrations, CLI.
- `apps/ui`: the React SPA.
- `library/`: integration entries, skills and their design prompts.
- `deploy/`: host setup and update scripts.

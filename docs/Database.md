# Database

PostgreSQL 16 + PostGIS (with `postgis_raster` and `citext`). The schema is defined by
`apps/server/migrations/0001_app_schema.sql` and the numbered migrations after it
(see [Migrations](#migrations)). Two schemas with a hard boundary:

- `app`: the platform's own state, secrets included. Never granted to query roles.
- `data`: destination tables created from definitions, plus the raster SQL mirror and
  the area of interest. The whole query surface: dashboards and Explore read it as
  `sql_engine`.

Two kinds of working schema also exist: `draft_<session>` (a design session's scratch
destination tables, dropped when the session finishes or goes idle) and `stage`
(per-run staging tables for table files, dropped after each run and by the reaper).

## Roles

`sql_engine` (NOLOGIN) has USAGE on `data`, SELECT on its tables through default
privileges, EXECUTE on `data.aoi_stats`, and nothing on `app`. The application user is
a member, so dashboard and Explore queries run as `SET LOCAL ROLE sql_engine` inside a
read-only transaction with a 15 s statement timeout and search path `data, public`.
The migration creates the role when it is missing and grants it to the application
user; when that user is not a superuser, `deploy/setup.sh` does both beforehand, along
with `CREATE EXTENSION postgis_raster`.

## app schema

### integrations

Installed integrations. The definition is the integration's single specification; a
library entry only provides its starting values.

| column | type | notes |
|---|---|---|
| id | text pk | definition id (natural key; renaming is a new integration) |
| definition | jsonb | current definition |
| version | int | current version; composite FK into integration_versions (deferred) keeps it from dangling |
| enabled | boolean | false pauses scheduling and webhook-triggered runs |
| status | text | `draft` (a design session's uncertified draft) or `ready` (certified by a cold run, or a library/import install) |
| webhook_token | uuid unique | capability secret of the webhook URL `/hooks/<token>`; rotatable |
| created_at, updated_at | timestamptz | |

A design session's draft row is updated in place as the agent edits it; `finish`
installs the certified definition through the normal install path.

### integration_versions

Append-only archive of definition versions, written on install and edit. An install
whose definition is unchanged keeps its version (library re-syncs are no-ops); any
change bumps the per-integration version. Lineage from runs stays resolvable after
edits, and each version records who installed it. Rollback is re-installing an archived
definition, which becomes a new version.

| column | type | notes |
|---|---|---|
| integration_id, version | text, int pk | version counts up from 1 per integration |
| definition | jsonb | |
| created_by | uuid fk null | installing user; null for CLI installs |
| created_at | timestamptz | |

### integration_secrets

Per-integration secret values, injected only into that integration's runs and design
snippets, so a definition cannot receive a credential by declaring another
integration's secret name. Write-only over the API; copying between integrations
re-encrypts server side.

| column | type | notes |
|---|---|---|
| integration_id, name | text, text pk | integration_id cascades on integration delete |
| value | bytea | AES-256-GCM (12-byte IV, 16-byte tag, ciphertext); key from `INTEGRATOR_SECRET_KEY` |
| created_at, updated_at | timestamptz | |

### runs

One row per run. Doubles as the job queue.

- Partial unique indexes allow at most one `running` and one `queued` run per
  integration, and likewise per design session, so serialization and queue dedup are
  constraints: cron and webhook enqueues insert with ON CONFLICT DO NOTHING.
- A worker selects up to ten due queued candidates, oldest `scheduled_at` first, and claims each with a conditional UPDATE (`WHERE status =
  'queued'`) that sets `running`, a fresh `attempt`, `claimed_by` and the heartbeat. A
  unique violation means the integration already has a running run; that candidate is
  skipped.
- Manual runs are inserted directly as `running` with their own attempt token.
  Design-session runs (`session_id` set) are never claimed by workers: the designer
  executes them in-process.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| integration_id | text fk null | null for design-session runs |
| session_id | uuid fk null | owning design session for its scratch runs (one of the two is set) |
| trigger | text | cron, webhook, manual, rebuild (a manual run started cold: no previous state, empty `/work`), agent (design session) |
| status | text | queued, running, succeeded, failed, timeout |
| scheduled_at, started_at, finished_at | timestamptz | a webhook run's `scheduled_at` includes its batch window |
| claimed_by, heartbeat_at | text, timestamptz | worker lease |
| attempt | uuid null | token of the current claim; the heartbeat and the success commit both require it, so a stale attempt cannot land after a reclaim. Null for design-session runs |
| definition_version | int null | archived definition that ran (composite FK with integration_id); set on success, null for design-session runs |
| file_pins | jsonb null | `{slotId: versionId}` fixed when the run was created (an upload, revert, or a design session's finish); unpinned slots read their current version |
| inputs | jsonb | lineage: the `aoi` the run executed with (null = full extent), the resolved `settings` it passed as `ctx.params`, materialized input snapshot ids and extract row counts, and the file versions read (as in `/in/manifest.json`). Written before the job starts, so a failed run still records what it read |
| state_out | jsonb | state returned by the run; the next run reads the latest succeeded run's |
| stats | jsonb | rows per table, snapshot count, duration, `/work` MB |
| flags | jsonb null | validation findings of a successful run (`{destinationId, field, rule, count?, observedMin?, observedMax?, message}`); null when none |
| error | text | secret values masked |
| log | text | last 256 KB of stderr plus limit notes and flag lines, secret values masked; cleared after 90 days |

### Run commit and recovery

- All Postgres effects of a run commit in one transaction: table applies, validation of
  the rows written, snapshot inserts and supersessions, the `data.rasters`
  registrations, webhook consumption, `state_out`, `flags`, the file slots' current
  versions, and the flip to `succeeded`. A failed run commits only its own run record.
- Raster files land in the store, and table files in `stage`, before the transaction,
  so a failure leaves only files: housekeeping removes store snapshot directories no
  row refers to once a day old.
- Workers heartbeat every 15 s. A reaper fails runs whose heartbeat is over 5 minutes
  old, releasing the one-running constraint; cron and webhooks enqueue the next run as
  usual. A worker that cannot reach the database kills its own job before its lease
  could be reaped.
- A reclaim cannot double-apply: when the heartbeat update matches no row the worker
  kills its container, and the success commit's run-row update also carries the token
  and rolls the whole transaction back on zero rows. Job containers are labelled with
  their run id, and the scheduler removes every labelled container at startup.

### webhook_events

Buffered webhook payloads. A run receives every pending event, oldest first, as
`webhookData`; events are marked consumed (`run_id`) in the success commit, so a failed
run leaves them pending for the retry. A receipt for a paused or draft integration only
buffers. Consumed events are deleted after 30 days.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| integration_id | text fk | |
| payload | jsonb | |
| received_at | timestamptz | |
| run_id | uuid fk null | run that consumed it |

### file_versions

One row per uploaded file version ([Integration Files](Integration%20Files.md)). Bytes
live in the file store at `<id><ext>`; the uploaded filename is display data only.

| column | type | notes |
|---|---|---|
| id | uuid pk | also the stored file's name |
| integration_id | text fk null | owning integration; null while a design session's upload waits for its draft row, which adopts it |
| session_id | uuid fk null | design session it was attached in (one of the two is set) |
| slot_id, version | text, int | version counts up from 1 per slot of its owner; unique per owner |
| filename | text | as uploaded, control characters stripped; may carry personal data, so not shown to viewers |
| ext | text | lowercase extension matching `^\.[a-z0-9]{1,10}$`, or empty |
| sha256, size_bytes | text, bigint | kept after a purge so lineage still resolves |
| uploaded_by | uuid fk null | uploading user |
| uploaded_at | timestamptz | |
| purged_at, purged_by | timestamptz, text null | an admin removed the bytes (`cli.js files purge`); purged versions cannot be pinned or downloaded |

### file_slots

The version each slot of an integration reads when a run pins nothing. Set only inside
a successful production run's commit, so it always matches what the tables hold;
design-session runs never move it. A slot with no row awaits its first upload, and
unpinned runs of that integration are refused (the scheduler and webhook receipts do
not enqueue them).

| column | type | notes |
|---|---|---|
| integration_id, slot_id | text, text pk | |
| current_version_id | uuid fk | the version the last successful run read |
| updated_at | timestamptz | |

### raster_layers

| column | type | notes |
|---|---|---|
| id | text pk | layerId from the definition; `draft_<session>_<layerId>` for design-session previews |
| integration_id | text fk null | owning integration; null for session preview layers |
| session_id | uuid fk null | owning design session for preview layers (one of the two is set) |
| name | jsonb | LocalizedString |
| temporality | text | time-series, current-only |
| bands | jsonb | BandSpec[] from the definition (units, nodata, rendering) |
| current_snapshot_id | uuid fk null | |
| mask_geom | geometry(MultiPolygon, 4326) null | shape tiles are clipped to when drawn: the deployment AOI shape for a layer whose integration inherits the default AOI, the integration's own countries otherwise; null (no clip) for an explicit box or full extent. Rendering only; stored rasters are never cut |
| retention_days | integer null | the destination's `retention.days`; null keeps all history |

Preview layers are excluded from the public layer list, STAC, retention and the SQL
mirror. A session's scratch area (draft schema, preview layers with their snapshots and
files, session `/work`) is removed at `finish`, and by housekeeping once the session
has been idle (not active) for 30 days; the transcript stays and a resumed session
simply re-runs.

### raster_snapshots

A run's snapshots are inserted as `promoted` in its commit transaction. A current-only layer
marks its previous promoted snapshot `superseded`; a time-series layer does the same
for a re-ingested observation time (same `observed_at` and `observed_end`).

`current_snapshot_id` is the newest promoted snapshot whose `observed_at` is not in the
future (the nearest future one if none), re-evaluated at each promotion and on every
reaper tick, so projection layers advance without a run.

The retention sweep (after every scheduler run, hourly, and `cli.js prune-snapshots`)
deletes superseded snapshots and promoted time-series snapshots whose
`coalesce(observed_end, observed_at)` falls before the layer's `retention_days`, with
their store files and cached tiles; sources and `data.rasters` rows cascade. A layer's
current snapshot is never deleted.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| layer_id | text fk | |
| observed_at | timestamptz | RasterArtifact.timestamp |
| observed_end | timestamptz null | RasterArtifact.timestampEnd |
| footprint | geometry(Polygon, 4326) null | envelope of all sources; null when empty |
| crs | text | CRS shared by the files (default `EPSG:4326`); source grids are preserved, never warped at ingest |
| cell_size_m | double precision null | approximate cell width in metres from the first file's grid (lon/lat grids convert at the equator); null for an empty snapshot |
| bands | jsonb | band ids in file order |
| size_bytes | bigint | total across sources |
| run_id | uuid fk | producing run (lineage) |
| status | text | promoted, superseded |
| metadata | jsonb null | RasterArtifact.metadata: lineage the code attached (source URLs, product versions), a JSON object of at most 64 KB; shown on the layer page and as `integrator:metadata` in STAC items |
| created_at | timestamptz | |

### raster_sources

The files of a snapshot, in declaration order: one for a single-file snapshot, many for
a tiled product, none for an empty snapshot (a published "nothing observed"). Tiles,
downloads, SQL registration and `/in` materialization read a snapshot through its
sources; several files are mosaicked with a VRT.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| snapshot_id | uuid fk | cascades on snapshot delete |
| ordinal | int | position in RasterArtifact.sources; unique per snapshot |
| path | text | relative to the raster store root |
| footprint | geometry(Polygon, 4326) | |
| size_bytes | bigint | |

### data_tables

Single-writer registry for `data` tables, and the API's source of column metadata
(units, enum vocabularies).

| column | type | notes |
|---|---|---|
| id | text pk | table name in the data schema; one owning integration per table |
| integration_id | text fk | owning integration |
| spec | jsonb | TableDestination spec |
| created_at, updated_at | timestamptz | |

### dashboards and dashboard_versions

Specified in [Dashboards](Dashboards.md). The dashboard id is a renamable slug: every
reference (`dashboard_versions.dashboard_id`) cascades on update, and
the composite FK from `current_version` into `dashboard_versions` is deferred to
commit.

`dashboards`:

| column | type | notes |
|---|---|---|
| id | text pk | slug |
| name | text | |
| current_version | int null | |
| public | boolean | opens the view surface to unauthenticated viewers |
| published_by, published_at | uuid fk, timestamptz null | who made it public and when; cleared when made private |
| created_at, updated_at | timestamptz | |

`dashboard_versions`:

| column | type | notes |
|---|---|---|
| dashboard_id, version | text, int pk | |
| source | text | React source |
| queries | jsonb | named parameterized SQL, frozen at save |
| layers | jsonb | raster layers the version may draw; the scoped tile route serves only these |
| kit_version | text | |
| bundle_js, bundle_css | text | compiled output, immutable |
| created_by | uuid fk null | who saved the version |
| restored_from | int null | the version a restore copied |
| created_at | timestamptz | |

### agent_sessions

Serialized agent sessions: the controller saves messages, client state and usage after
every step, so any server process resumes any session.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | text | designer, assistant (Explore), dashboard |
| user_id | uuid fk null | who runs the session; null for CLI sessions |
| status | text | active (a loop is running or was interrupted), paused, finished (task done; the session still accepts messages) |
| messages | jsonb | model transcript |
| client_state | jsonb | per kind: the designer draft and its certification (bound to an integration through `definition.id`), the dashboard draft (bound through `dashboardId`), Explore's stored query results |
| usage | jsonb | `{steps, inputTokens, outputTokens}` |
| error | text null | what crashed the last loop (model/provider failure); cleared on the next step |
| locale | text null | UI locale at creation, which seeds the base language of authored text; null for CLI sessions |
| created_at, updated_at | timestamptz | |

### ai_usage

Daily AI token usage (input plus output) per user, checked before every model call
against the caps in the `ai_limits` setting. Days are UTC.

| column | type | notes |
|---|---|---|
| day | date | |
| user_id | uuid fk null | null for CLI sessions; cascades on user delete; unique with day (NULLS NOT DISTINCT) |
| tokens | bigint | |

### users

Roles: admin manages users, secrets and settings; editor manages integrations,
dashboards and design sessions; viewer reads data and dashboards and uses Explore.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| email | citext unique | |
| password_hash | text | scrypt |
| role | text | admin, editor, viewer |
| disabled | boolean | offboarding without deleting attribution |
| failed_logins | int | lockout counter |
| locked_until | timestamptz null | |
| ai_acknowledged_at | timestamptz null | one-time acceptance that AI features send data to a hosted model provider |
| password_changed_at | timestamptz | age clock for the optional password expiry (setting `account_policy`) |
| last_active_at | timestamptz | last sign-in, session or API token use (refreshed at most hourly); clock for the optional inactivity disabling |
| created_at, updated_at | timestamptz | |

### auth_sessions

Signed-in browser sessions (30 days); revocation is row deletion. Expired rows are
deleted by housekeeping.

| column | type | notes |
|---|---|---|
| token_hash | text pk | hash of the session token, never the token itself |
| user_id | uuid fk | |
| expires_at | timestamptz | |
| created_at | timestamptz | |

### api_tokens

Personal access tokens for the programmatic API. The bearer secret is shown once at
mint; the token acts with its user's current role at every use.

| column | type | notes |
|---|---|---|
| token_hash | text pk | SHA-256 of the bearer secret |
| user_id | uuid fk | |
| name | text | owner-chosen label |
| created_at | timestamptz | |
| last_used_at | timestamptz null | stamped on every authentication |
| expires_at | timestamptz null | null = no expiry |

### settings

Deployment behaviour administrators change at runtime through the UI (infrastructure
wiring stays in environment variables; see `apps/server/src/config.ts` and
`.env.example`).

| column | type | notes |
|---|---|---|
| key | text pk | |
| value | jsonb | |
| updated_at | timestamptz | |

Keys:

- `default_aoi`: `{bbox: [west, south, east, north], countries?: [ISO3...], name?}`.
  Definitions whose `aoi` is omitted inherit it at run time. Saving it rebuilds
  `data.aoi` and the layers' map masks.
- `site_title`: the deployment's display name (home page, STAC landing).
- `locales`: the locales the language picker offers and catalog translation targets;
  unset means every supported locale.
- `ai`: `{provider, model, baseUrl, apiKey}`, the API key AES-256-GCM encrypted under
  `INTEGRATOR_SECRET_KEY`.
- `ai_limits`: `{userDailyTokens, deploymentDailyTokens}`, each a positive integer or
  null for no cap; unset means 5,000,000 and 25,000,000.
- `account_policy`: `{passwordMaxAgeDays, inactiveDisableDays}`, each a whole number of
  days (1 to 3650) or null to turn the rule off; unset means both off. Expiry is checked
  at sign-in; inactive accounts are disabled by the daily housekeeping sweep.

### migrations

| column | type | notes |
|---|---|---|
| name | text pk | migration file name |
| applied_at | timestamptz | |

## data schema

### Destination tables

One table per TableDestination, named `tableId` verbatim (validated
`^[a-z][a-z0-9_]{0,62}$`; identifiers are always quoted).

| ColumnSpec | Postgres |
|---|---|
| text, enum | text |
| number | double precision |
| integer | bigint |
| boolean | boolean |
| date | date |
| datetime | timestamptz |
| geometry | geometry(Geometry, 4326), GIST-indexed |
| json | jsonb |

System columns on every table: `_id bigint generated always as identity` (pk) and
`_run_id uuid` (per-row lineage).

Actions: replace = build a new table, fill it, drop the old one and rename, in the
commit transaction; append = insert; merge = upsert on a unique index over
`mergeColumns`. Replace resets `_id`, so row identity is not stable across
replacements. New tables pick up `sql_engine`'s SELECT through default privileges.

Evolution is the destination code's job, never migrations: a column added to the
definition is added to the table at install. Removed or retyped columns are not
altered in place; a `replace` table is rebuilt from the definition on its next run.

### rasters

The out-db SQL mirror of promoted snapshots: tiled PostGIS out-db rasters whose bands
reference the COG files in the raster store, so SQL joins raster values against vector
rows (ST_Value at features, ST_SummaryStats over clipped buffers) under `sql_engine`
like any table. Pixels never enter the database.

Registration is required and happens inside each run's commit transaction: a snapshot
the database cannot register fails the run and rolls back its promotion. Design-session
runs validate registration (CRS resolvable, files describable) without writing rows.
Rows of snapshots that are no longer promoted are pruned after each run; deleted
snapshots cascade. `cli.js register-rasters` registers promoted snapshots missing from
the mirror; `--all` re-registers every one (after a store move or a tile size change).

Requires the `postgis_raster` extension, `postgis.enable_outdb_rasters = on` and
`postgis.gdal_enabled_drivers` set (database-level settings the migration attempts and
`deploy/setup.sh` sets as superuser), and a Postgres server process that can read the
raster store path. Store files are written world-readable for that reason.

| column | type | notes |
|---|---|---|
| layer_id | text | |
| snapshot_id | uuid fk | cascades on snapshot delete |
| observed_at, observed_end | timestamptz | snapshot validity, for time filtering in SQL |
| rast | raster | 1024 px out-db tiles referencing one source file, covering the full grid including nodata areas; a multi-file snapshot has rows for each file. GIST index on `ST_ConvexHull(rast)` |

### aoi

The deployment's area of interest as a shape. One row (`id = 1`), rebuilt from the
`default_aoi` setting when it is saved, by `cli.js migrate`, and at server start: the
selected countries' land outlines from the bundled Natural Earth 1:10m boundaries with
lakes removed, cut to the box (the box itself when no countries are selected). Absent
when no default AOI is configured.

| column | type | notes |
|---|---|---|
| id | smallint pk | always 1 |
| name | text | display name of the selection |
| countries | text[] | ISO3 codes |
| bbox | float8[] | [west, south, east, north] |
| geom | geometry(MultiPolygon, 4326) | |
| land_area_km2 | float8 | |
| boundary_source, boundary_version | text | provenance, reported by aoi_stats |
| updated_at | timestamptz | |

### aoi_stats()

`data.aoi_stats(layer_id, at => null, threshold => null, op => '<', band => 1)`:
area-weighted statistics of one raster layer over `data.aoi`, from the latest snapshot
starting on or before `at` (the newest when null; the earliest when none is that old).
Returns one row: `mean`, `share` (of the area meeting `op threshold`; null without a
threshold), `coverage` (share of the area's land with a valid pixel), `cells`,
`cell_km2`, `method`, `observed_at`, `observed_end`, `boundary`. Up to about 25,000
pixels it weights each pixel by the part inside the boundary (`exact`); above that it
clips whole pixels and weights them by their area at their own latitude (`clip`).
Nodata (declared or in the file) and NaN pixels never count. SECURITY DEFINER so
`sql_engine` can read the layer's declared nodata from `app.raster_layers`.

## Migrations

Numbered `.sql` files in `apps/server/migrations`, applied in filename order, each in
its own transaction, and recorded in `app.migrations`. The runner (`migrations.ts`)
creates the `app` schema and the migrations table, and holds an advisory lock so
concurrent runs serialize. Forward-only: recovery is a restore, not a down migration.
Migrations run only through `cli.js migrate`; `serve` never migrates. They cover the
app schema and the fixed `data` objects; destination tables are definition-driven.

## Raster store

Postgres never holds raster bytes. `raster_sources.path` is relative to the store root
(`RASTER_STORE_PATH`, default `./raster-store`), layout
`<layerId>/<snapshotId>/<ordinal>.tif`. The store is always a plain directory; object
storage can be attached as a filesystem mount, provided the Postgres server can read
the same path for the out-db mirror. Snapshot files are immutable; they are deleted
only by the retention sweep, scratch cleanup and orphan housekeeping. Tiles, point
lookups and downloads read the COGs through GDAL.

## File store

Uploaded integration files live under `FILE_STORE_PATH` (default `./file-store`), one
file per version at `<versionId><ext>`, never in Postgres. Uploads stream into `.tmp`
and are renamed into place inside the transaction that inserts their row; jobs that
read files get their `/in` under `.jobs`, so versions hardlink rather than copy. At
server start, `.tmp` and `.jobs` entries and version-named files with no row are removed
once they are an hour old, leaving younger ones to whichever process owns them.

## Conventions

- IDs: text natural keys where identity comes from definitions (integrations, layers,
  tables, bands, file slots), keeping foreign keys and logs self-describing; uuid for
  server-generated rows (runs, snapshots, sessions, users, file versions). Definition
  ids are published identifiers (referenced from other definitions, frozen SQL and URLs
  no FK can reach), validated to `^[a-z][a-z0-9_]{0,62}$`; display names carry rename
  pressure, and changing an id creates a new identity.
- All timestamps are timestamptz, UTC.
- Growth: run rows are kept indefinitely (lineage); their logs, consumed webhook events
  and expired sign-in sessions are trimmed by daily housekeeping, and raster history by
  the retention sweep.

# Database

PostgreSQL 16 + PostGIS. Two schemas with a hard boundary:

- `app`: system tables. Secrets live here; user queries and any future read-only
  query roles have no grants on it.
- `data`: destination tables created from definitions. The entire query surface:
  the REST API reads here, and a future sql-engine role gets SELECT here only.

## app schema

### integration_versions

Append-only archive of definition versions, written on install and edit. An
install with an unchanged definition keeps its version (library re-syncs are
no-ops); any change bumps the per-integration version and archives the new
definition. Lineage from runs stays resolvable after definitions change, the
timeline of an integration is readable in order, and each version records who
installed it. Rollback is re-installing an archived definition, which becomes
a new version.

| column | type | notes |
|---|---|---|
| integration_id, version | text, int pk | version counts up from 1 per integration |
| definition | jsonb | |
| created_by | uuid fk null | installing user; null for CLI/library-sync installs |
| created_at | timestamptz | |

### integrations

Installed integrations. The definition is the integration's single
specification — the library entry only provides its starting values.

| column | type | notes |
|---|---|---|
| id | text pk | definition id (natural key; renames are new integrations) |
| definition | jsonb | synced definition |
| version | int | current version; composite FK into integration_versions (deferred) keeps it from dangling |
| enabled | boolean | |
| status | text | `draft` (design-session install, uncertified) or `ready` (cold run passed, or library install) |
| created_at, updated_at | timestamptz | |

### runs

One row per run. Doubles as the job queue: the scheduler inserts `queued` rows,
workers claim with FOR UPDATE SKIP LOCKED. Partial unique indexes on
integration_id enforce at most one `running` and one `queued` run per
integration, so serialization and queue dedup are constraints, not worker
discipline (the scheduler inserts with ON CONFLICT DO NOTHING). Claim order is
priority desc then scheduled_at; agent runs enqueue with elevated priority.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| integration_id | text fk null | null for design-session scratch runs |
| session_id | uuid fk null | owning design session for scratch runs (one of the two is set) |
| trigger | text | cron, webhook, manual, agent |
| status | text | queued, running, succeeded, failed, timeout, skipped |
| priority | int | queue claim order |
| params | jsonb | manual/backfill parameters, passed to the job |
| scheduled_at, started_at, finished_at | timestamptz | |
| claimed_by, heartbeat_at | text, timestamptz | worker lease |
| attempt | uuid null | token of the current claim; the heartbeat and the success commit both require it, so a stale attempt cannot land after a reclaim. Null for scratch runs |
| definition_version | int fk | which definition version ran (composite FK with integration_id); null until success and for scratch runs |
| file_pins | jsonb null | `{slotId: versionId}` fixed when the run was created (an upload, revert, or design session's finish); unpinned slots read their current version |
| inputs | jsonb | lineage: `aoi` the run executed with (null = full extent), materialized input snapshot ids and extract row counts, and the file versions read (`files`, as in /in/manifest.json). Written before the job starts, so a failed run still records what it read |
| state_out | jsonb | state returned by the run; the next run reads the latest succeeded run's |
| stats | jsonb | rows written, artifacts, bytes, duration |
| flags | jsonb | validation violations, freshness |
| error | text | |
| log | text | capped stderr tail (~256KB) |

### Run commit and recovery

- All Postgres effects of a run commit in one transaction: tabular apply,
  snapshot inserts and promotions, webhook consumption, state_out, the file
  slots' current versions, and the flip to succeeded. A failed run commits
  nothing but its own run record.
- Raster files land in the store before the commit, so failure leaves only
  orphans. GC removes never-promoted files past an age threshold and failed
  runs' /out output.
- Workers heartbeat while running; a reaper marks runs with stale heartbeats
  failed, releasing the one-running constraint. The next scheduler tick
  re-enqueues naturally.
- A reclaim cannot double-apply: the heartbeat update carries the attempt
  token, and when it matches no row the worker kills its container; the
  success commit's run-row update also carries the token and rolls the whole
  transaction back on zero rows. Job containers are labelled with their run
  id, and the scheduler removes every labelled container at startup, since a
  container whose process is gone has no one left to commit it.
- Backfill/reprocess is a manual run with params (e.g. a date range) and an
  optional force-cold flag: wiped /work, null previousState.

### file_versions

One row per uploaded file version (Integration Files.md). Bytes live in the
file store at `<id><ext>`; the uploaded filename is display data only.

| column | type | notes |
|---|---|---|
| id | uuid pk | also the stored file's name |
| integration_id | text fk null | owning integration; null while a design session's upload waits for its draft row, which adopts it |
| session_id | uuid fk null | design session it was attached in (one of the two is set) |
| slot_id, version | text, int | version counts up from 1 per slot of its owner; unique per owner |
| filename | text | as uploaded, control characters stripped; may carry personal data, so not shown to viewers |
| ext | text | lowercase extension validated `^\.[a-z0-9]{1,10}$`, or empty |
| sha256, size_bytes | text, bigint | kept after a purge so lineage still resolves |
| uploaded_by | uuid fk null | uploading user |
| uploaded_at | timestamptz | |
| purged_at, purged_by | timestamptz, text null | an admin removed the bytes (`cli.js files purge`); purged versions cannot be pinned or downloaded |

### file_slots

The version each slot of an integration reads when a run pins nothing. Set
only inside a successful production run's commit, so it always matches what
the tables hold; design-session runs (scratch) never move it. A slot with no
row awaits its first upload, and unpinned runs of that integration are refused
(the scheduler and webhook receipts do not enqueue them).

| column | type | notes |
|---|---|---|
| integration_id, slot_id | text, text pk | |
| current_version_id | uuid fk | the version the last successful run read |
| updated_at | timestamptz | |

### webhook_events

Buffered webhook payloads. A run receives all pending events batched, oldest
first, as webhookData[]; events are marked consumed (run_id) in the success
commit, so a failed run leaves them pending for the retry.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| integration_id | text fk | |
| payload | jsonb | |
| received_at | timestamptz | |
| run_id | uuid null | run that consumed it |

### raster_layers

| column | type | notes |
|---|---|---|
| id | text pk | layerId from the definition; `draft_<session>_<layerId>` for scratch previews |
| integration_id | text fk null | owning integration; null for session scratch layers |
| session_id | uuid fk null | owning design session for scratch preview layers |
| name | text | |
| temporality | text | time-series, current-only |
| bands | jsonb | BandSpec[] |
| retention_days | integer null | destination's retention.days; null keeps all history |
| current_snapshot_id | uuid null | |

Design sessions test-run into a scratch area: destination tables in a
`draft_<session>` schema, preview layers owned by the session (excluded from
the public layer list), /work keyed by session. finish installs the certified
definition and discards the scratch area; installed integrations are never
touched mid-design.

### raster_snapshots

Insert as `pending`; promotion flips status and `current_snapshot_id` in one
transaction. `current_snapshot_id` is the newest promoted snapshot whose
`observed_at` is not in the future (nearest future one if none), re-evaluated
on a scheduler tick so projection layers advance without a run. time-series
layers keep promoted history, trimmed to `retention_days` when the layer has
one; current-only marks the old snapshot `superseded`, as does re-ingesting a
time-series date. The retention sweep (after every scheduler run, hourly, and
`cli.js prune-snapshots`) deletes superseded snapshots and those whose
`coalesce(observed_end, observed_at)` falls before the window, with their
store files and cached tiles; a layer's current snapshot is never deleted. A snapshot's pixels
live in its `raster_sources` rows: one for a single-file snapshot, many for a
tiled product, none for an empty snapshot (a published "nothing observed").

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| layer_id | text fk | |
| observed_at | timestamptz | RasterArtifact.timestamp; named to avoid the type keyword |
| observed_end | timestamptz null | RasterArtifact.timestampEnd |
| footprint | geometry(Polygon, 4326) null | envelope of all sources; null when empty |
| crs | text | CRS shared by the files; source grids are preserved, never warped at ingest |
| cell_size_m | double precision null | approximate cell width in metres from the first file's grid (the STAC gsd); lon/lat grids convert at the equator; null for an empty snapshot |
| bands | jsonb | band ids in file order |
| size_bytes | bigint | total across sources |
| run_id | uuid | producing run (lineage) |
| status | text | pending, promoted, superseded |

### raster_sources

The files of a snapshot, in declaration order. Tiles, sampling, SQL
registration and /in materialization read a snapshot through its sources:
one file is used directly, several are mosaicked with a VRT.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| snapshot_id | uuid fk | cascades on snapshot delete |
| ordinal | int | position in RasterArtifact.sources; unique per snapshot |
| path | text | relative to the raster store root |
| footprint | geometry(Polygon, 4326) | |
| size_bytes | bigint | |
| created_at | timestamptz | |

### data_tables

Single-writer registry for data-schema tables, and the API's source of column
metadata (units, enum vocabularies).

| column | type | notes |
|---|---|---|
| id | text pk | table name in the data schema; one writer per table |
| integration_id | text fk | owning integration |
| spec | jsonb | TableDestination spec |
| created_at, updated_at | timestamptz | |

### settings

Deployment behavior administrators change at runtime through the UI (infra
wiring stays in environment variables; see config.ts). Known keys:

- `default_aoi`: `{bbox: [west, south, east, north], countries?: [ISO3...],
  name?}`. Definitions whose `aoi` is omitted inherit it at run time, so a
  deployment configured for one country scopes every library install
  automatically. The definition's tri-state wins otherwise: an explicit box
  clips to it; explicit null means the source's full extent.

Future: retention, cost caps, similar knobs.

| column | type | notes |
|---|---|---|
| key | text pk | |
| value | jsonb | |
| updated_at | timestamptz | |

### agent_sessions

Serialized sessions (messages + state), any server process resumes any session.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | text | designer, assistant, dashboard |
| user_id | uuid fk null | who runs the session; per-user cost caps aggregate on this |
| integration_id | text fk null | subject when kind is designer |
| dashboard_id | text fk null | subject when kind is dashboard |
| status | text | active, paused, finished |
| messages | jsonb | |
| client_state | jsonb | |
| usage | jsonb | tokens, cost, llm calls |
| error | text null | what crashed the last loop (model/provider failure); cleared on the next step |
| created_at, updated_at | timestamptz | |

### users

Roles: admin manages users, secrets, and settings; editor manages integrations
and agent sessions; viewer reads data and dashboards.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| email | citext unique | |
| password_hash | text | |
| role | text | admin, editor, viewer |
| disabled | boolean | offboarding without deleting attribution |
| failed_logins | int | |
| locked_until | timestamptz null | |
| created_at, updated_at | timestamptz | |

### auth_sessions

Logged-in sessions; revocation is row deletion. Expired rows trimmed by cleanup.

| column | type | notes |
|---|---|---|
| token_hash | text pk | hash of the session token, never the token itself |
| user_id | uuid fk | |
| expires_at | timestamptz | |
| created_at | timestamptz | |

### api_tokens

Personal access tokens for the programmatic API (migration 0002). Bearer secret
shown once at mint; the token inherits its user's role at every use.

| column | type | notes |
|---|---|---|
| token_hash | text pk | sha256 of the bearer secret |
| user_id | uuid fk | |
| name | text | owner-chosen label |
| created_at | timestamptz | |
| last_used_at | timestamptz | audit trail; stamped on every authentication |
| expires_at | timestamptz | null = no expiry |

### secrets

| column | type | notes |
|---|---|---|
| name | text pk | |
| value | bytea | AES-256-GCM; key from server environment |
| created_at, updated_at | timestamptz | |

### migrations

| column | type | notes |
|---|---|---|
| name | text pk | |
| applied_at | timestamptz | |

Plus `dashboards` and `dashboard_versions`, specified in Dashboards.md; a
composite FK keeps `current_version` from pointing at a version that does not
exist.

## data schema

One table per TableDestination, named `tableId` verbatim (validated
`^[a-z][a-z0-9_]*$` plus a reserved-word check at definition validation).

Column types:

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
`_run_id uuid` (per-row lineage, FUC-4).

Actions: replace = build new table, swap in one transaction; append = insert;
merge = upsert on a unique index over mergeColumns. Replace resets `_id` and
reapplies grants; row identity is not stable across replacements.

Evolution is the destination adapter's job, never migrations: additive column
changes apply automatically; type changes or removals rebuild the table.

### rasters

The out-db SQL mirror of promoted snapshots: tiled PostGIS out-db rasters
whose bands reference the COG files in the raster store, so SQL joins raster
values against vector rows (ST_Value at features, ST_SummaryStats over
clipped buffers) under sql_engine like any table. Pixels never enter the
database. Written best-effort after each run's commit and by
`cli.js register-rasters`; superseded snapshots are pruned; hard snapshot
deletes cascade via FK. Scratch previews are never mirrored.

Requires (guaranteed by the reference deployment, checked at registration):
the `postgis_raster` extension, `postgis.enable_outdb_rasters = on` and
`postgis.gdal_enabled_drivers` set (superuser settings; migration attempts
them, deploy script sets them as postgres), and the Postgres server able to
read the raster store path. Deployments where the database cannot reach the
files (e.g. a managed remote Postgres) lose this mirror only; catalog API,
tiles, and downloads are unaffected.

| column | type | notes |
|---|---|---|
| layer_id | text | |
| snapshot_id | uuid fk | cascades on snapshot delete |
| observed_at, observed_end | timestamptz | snapshot validity, for time filtering in SQL |
| rast | raster | 1024px out-db tiles referencing one source file, covering the full grid including nodata areas; a tiled snapshot has rows for each file. `cli.js register-rasters --all` re-tiles existing snapshots after a tile size change |

## Migrations

Numbered .sql files in the server, applied in order at boot, recorded in
app.migrations. Hand-rolled runner, forward-only (recover by restore, not down
migrations). Applies to the app schema only; data is definition-driven.

## Raster store

Postgres never holds raster bytes; sources store paths relative to a store
root, layout `<layerId>/<snapshotId>/<ordinal>.tif`. The store code path is always a
plain directory: local disk by default, and S3-compatible backends attach as a
FUSE mount (rclone/s3fs, one systemd unit; ~zero overhead for COG reads in
mWater production experience). No S3 SDK, no /vsis3/ credentials in GDAL.
Snapshot files are immutable; deletion happens only through supersede cleanup.

Promoted snapshots are also mirrored as out-db PostGIS rasters (the `rasters` table above) so SQL can read pixels at query time; tiles and point lookups go through GDAL against the COGs.

## File store

Uploaded integration files live under `FILE_STORE_PATH` (default
`./file-store`), one file per version at `<versionId><ext>`, never in
Postgres. Uploads stream into `.tmp` and are renamed into place inside the
transaction that inserts their row; jobs that read files get their `/in`
under `.jobs`, so versions hardlink rather than copy. Boot cleanup removes
`.tmp` and `.jobs` entries and version-named files with no live row once they
are an hour old, leaving younger ones to whichever process owns them.

## Conventions

- IDs: text natural keys where identity comes from definitions (integrations,
  layers, tables, bands), keeping foreign keys and logs self-describing; uuid
  for server-generated rows (runs, snapshots, sessions, users). Definition ids
  are published identifiers (referenced from other definitions, frozen SQL, and
  URLs that no FK can reach), validated to `^[a-z][a-z0-9_]{0,62}$`; display
  names carry rename pressure, and changing an id is creating a new identity.
- All timestamps are timestamptz, UTC.
- runs, webhook_events, and expired auth_sessions grow unbounded; a periodic
  cleanup job trims them, retention configurable.

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

Installed integrations: a synced library definition plus deployment overrides.

| column | type | notes |
|---|---|---|
| id | text pk | definition id (natural key; renames are new integrations) |
| definition | jsonb | synced definition |
| version | int | current version; composite FK into integration_versions (deferred) keeps it from dangling |
| overrides | jsonb | deployment overrides: aoi, trigger, limits |
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
| definition_version | int fk | which definition version ran (composite FK with integration_id); null until success and for scratch runs |
| inputs | jsonb | resolved snapshot ids, extract row counts (lineage) |
| state_out | jsonb | state returned by the run; the next run reads the latest succeeded run's |
| stats | jsonb | rows written, artifacts, bytes, duration |
| flags | jsonb | validation violations, freshness |
| error | text | |
| log | text | capped stderr tail (~256KB) |

### Run commit and recovery

- All Postgres effects of a run commit in one transaction: tabular apply,
  snapshot inserts and promotions, webhook consumption, state_out, and the flip
  to succeeded. A failed run commits nothing but its own run record.
- Raster files land in the store before the commit, so failure leaves only
  orphans. GC removes never-promoted files past an age threshold and failed
  runs' /out output.
- Workers heartbeat while running; a reaper marks runs with stale heartbeats
  failed, releasing the one-running constraint. The next scheduler tick
  re-enqueues naturally.
- Backfill/reprocess is a manual run with params (e.g. a date range) and an
  optional force-cold flag: wiped /work, null previousState.

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
| current_snapshot_id | uuid null | |

Design sessions test-run into a scratch area: destination tables in a
`draft_<session>` schema, preview layers owned by the session (excluded from
the public layer list), /work keyed by session. finish installs the certified
definition and discards the scratch area; installed integrations are never
touched mid-design.

### raster_snapshots

Insert as `pending`; promotion flips status and `current_snapshot_id` in one
transaction. time-series layers keep promoted history; current-only marks the
old snapshot `superseded` (file deleted asynchronously).

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| layer_id | text fk | |
| observed_at | timestamptz | RasterArtifact.timestamp; named to avoid the type keyword |
| observed_end | timestamptz null | RasterArtifact.timestampEnd |
| footprint | geometry(Polygon, 4326) | |
| crs | text | CRS of the file; source grids are preserved, never warped at ingest |
| path | text | relative to the raster store root |
| bands | jsonb | band ids in file order |
| size_bytes | bigint | |
| run_id | uuid | producing run (lineage) |
| status | text | pending, promoted, superseded |
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

Deployer configuration: retention, cost caps, model provider, similar knobs.

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

## Migrations

Numbered .sql files in the server, applied in order at boot, recorded in
app.migrations. Hand-rolled runner, forward-only (recover by restore, not down
migrations). Applies to the app schema only; data is definition-driven.

## Raster store

Postgres never holds raster bytes; snapshots store paths relative to a store
root, layout `<layerId>/<snapshotId>.tif`. The store code path is always a
plain directory: local disk by default, and S3-compatible backends attach as a
FUSE mount (rclone/s3fs, one systemd unit; ~zero overhead for COG reads in
mWater production experience). No S3 SDK, no /vsis3/ credentials in GDAL.
Snapshot files are immutable; deletion happens only through supersede cleanup.

Rasters are not registered in PostGIS (no out-db raster table, unlike mWater):
no query-time path computes over raster bytes. Raster-to-number crossings are
batch products of jobs (zonal stats, exposure) landing in data tables; tiles and
point lookups go through GDAL against the COGs. If query-time raster SQL is ever
needed, out-db registration on promotion is an additive change; path stays
authoritative.

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

# Database

PostgreSQL 16 + PostGIS. Two schemas with a hard boundary:

- `app`: system tables. Secrets live here; user queries and any future read-only
  query roles have no grants on it.
- `data`: destination tables created from definitions. The entire query surface:
  the REST API reads here, and a future sql-engine role gets SELECT here only.

## app schema

### integrations

Installed integrations: a synced library definition plus deployment overrides.

| column | type | notes |
|---|---|---|
| id | text pk | definition id (natural key; renames are new integrations) |
| definition | jsonb | synced definition |
| definition_hash | text | content hash; recorded on runs for lineage |
| overrides | jsonb | deployment overrides: aoi, trigger, limits |
| enabled | boolean | |
| created_at, updated_at | timestamptz | |

### runs

One row per run. Doubles as the job queue: the scheduler inserts `queued` rows,
workers claim with FOR UPDATE SKIP LOCKED. Runs are serialized per integration.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| integration_id | text fk | |
| trigger | text | cron, webhook, manual, agent |
| status | text | queued, running, succeeded, failed, timeout, skipped |
| scheduled_at, started_at, finished_at | timestamptz | |
| definition_hash | text | which version of the definition ran |
| inputs | jsonb | resolved snapshot ids, extract row counts (lineage) |
| state_out | jsonb | state returned by the run; the next run reads the latest succeeded run's |
| stats | jsonb | rows written, artifacts, bytes, duration |
| flags | jsonb | validation violations, freshness |
| error | text | |
| log | text | capped stderr tail (~256KB) |

### webhook_events

Buffered webhook payloads, passed to the consuming run as webhookData.

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
| id | text pk | layerId from the definition |
| integration_id | text fk | owning integration |
| name | text | |
| temporality | text | time-series, current-only |
| bands | jsonb | BandSpec[] |
| current_snapshot_id | uuid null | |

### raster_snapshots

Insert as `pending`; promotion flips status and `current_snapshot_id` in one
transaction. time-series layers keep promoted history; current-only marks the
old snapshot `superseded` (file deleted asynchronously).

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| layer_id | text fk | |
| timestamp | timestamptz | |
| timestamp_end | timestamptz null | |
| footprint | geometry(Polygon, 4326) | |
| path | text | relative to the raster store root |
| bands | jsonb | band ids in file order |
| size_bytes | bigint | |
| run_id | uuid | producing run (lineage) |
| status | text | pending, promoted, superseded |
| created_at | timestamptz | |

### agent_sessions

Serialized sessions (messages + state), any server process resumes any session.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | text | designer, assistant |
| integration_id | text null | |
| status | text | active, paused, finished |
| messages | jsonb | |
| client_state | jsonb | |
| usage | jsonb | tokens, cost, llm calls |
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
| failed_logins | int | |
| locked_until | timestamptz null | |
| created_at, updated_at | timestamptz | |

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

Plus `dashboards` and `dashboard_versions`, specified in Dashboards.md.

## data schema

One table per TableDestination, named `tableId` verbatim (validated
`^[a-z][a-z0-9_]*$` plus a reserved-word check at definition validation).

Column types:

| ColumnSpec | Postgres |
|---|---|
| text, enum | text |
| number | double precision |
| boolean | boolean |
| date | date |
| datetime | timestamptz |
| geometry | geometry(Geometry, 4326), GIST-indexed |
| json | jsonb |

System columns on every table: `_id bigint generated always as identity` (pk) and
`_run_id uuid` (per-row lineage, FUC-4).

Actions: replace = build new table, swap in one transaction; append = insert;
merge = upsert on a unique index over mergeColumns.

Evolution is the destination adapter's job, never migrations: additive column
changes apply automatically; type changes or removals rebuild the table.

## Migrations

Numbered .sql files in the server, applied in order at boot, recorded in
app.migrations. Hand-rolled runner, forward-only (recover by restore, not down
migrations). Applies to the app schema only; data is definition-driven.

## Raster store

Postgres never holds raster bytes; snapshots store paths relative to a store
root. The root is a local directory by default or an S3-compatible bucket, same
layout either way: `<layerId>/<snapshotId>.tif`. GDAL reads remote stores via
/vsis3/. Snapshot files are immutable; deletion happens only through supersede
cleanup.

Rasters are not registered in PostGIS (no out-db raster table, unlike mWater):
no query-time path computes over raster bytes. Raster-to-number crossings are
batch products of jobs (zonal stats, exposure) landing in data tables; tiles and
point lookups go through GDAL against the COGs. If query-time raster SQL is ever
needed, out-db registration on promotion is an additive change; path stays
authoritative.

## Conventions

- IDs: text natural keys where identity comes from definitions (integrations,
  layers, tables, bands), keeping foreign keys and logs self-describing; uuid
  for server-generated rows (runs, snapshots, sessions, users).
- All timestamps are timestamptz, UTC.

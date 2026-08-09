-- App schema per Database.md. The app/data split is the security boundary:
-- query roles never get grants on app.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS data;

CREATE TABLE app.integrations (
  id text PRIMARY KEY,
  definition jsonb NOT NULL,
  version int NOT NULL,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only archive of definition versions: lineage from runs stays
-- resolvable after edits, and the archive records who installed each version.
-- created_by FK is added after app.users below.
CREATE TABLE app.integration_versions (
  integration_id text NOT NULL REFERENCES app.integrations(id),
  version int NOT NULL,
  definition jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, version)
);

-- The current pointer cannot dangle; deferred so an install writes the
-- integration row and its archive row in one transaction, in either order
ALTER TABLE app.integrations
  ADD CONSTRAINT integrations_version_fk
  FOREIGN KEY (id, version) REFERENCES app.integration_versions(integration_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id text NOT NULL REFERENCES app.integrations(id),
  trigger text NOT NULL CHECK (trigger IN ('cron', 'webhook', 'manual', 'agent')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped')),
  priority int NOT NULL DEFAULT 0,
  params jsonb,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  claimed_by text,
  heartbeat_at timestamptz,
  definition_version int,
  inputs jsonb,
  state_out jsonb,
  stats jsonb,
  flags jsonb,
  error text,
  log text
);

-- Which archived definition a run executed; unchecked while definition_version
-- is null (queued/failed runs, session scratch runs)
ALTER TABLE app.runs
  ADD CONSTRAINT runs_definition_version_fk
  FOREIGN KEY (integration_id, definition_version)
  REFERENCES app.integration_versions(integration_id, version);

CREATE INDEX runs_integration_idx ON app.runs (integration_id, scheduled_at DESC);
CREATE INDEX runs_queue_idx ON app.runs (priority DESC, scheduled_at) WHERE status = 'queued';
-- Per-integration serialization as constraints, not worker discipline
CREATE UNIQUE INDEX runs_one_running_idx ON app.runs (integration_id) WHERE status = 'running';
CREATE UNIQUE INDEX runs_one_queued_idx ON app.runs (integration_id) WHERE status = 'queued';

CREATE TABLE app.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id text NOT NULL REFERENCES app.integrations(id),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES app.runs(id)
);

CREATE INDEX webhook_events_pending_idx ON app.webhook_events (integration_id, received_at)
  WHERE run_id IS NULL;

CREATE TABLE app.raster_layers (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES app.integrations(id),
  name text NOT NULL,
  temporality text NOT NULL CHECK (temporality IN ('time-series', 'current-only')),
  bands jsonb NOT NULL,
  current_snapshot_id uuid
);

CREATE TABLE app.raster_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id text NOT NULL REFERENCES app.raster_layers(id),
  observed_at timestamptz NOT NULL,
  observed_end timestamptz,
  footprint geometry(Polygon, 4326) NOT NULL,
  crs text NOT NULL DEFAULT 'EPSG:4326',
  path text NOT NULL,
  bands jsonb NOT NULL,
  size_bytes bigint,
  run_id uuid NOT NULL REFERENCES app.runs(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raster_snapshots_layer_time_idx ON app.raster_snapshots (layer_id, observed_at DESC);

ALTER TABLE app.raster_layers
  ADD CONSTRAINT raster_layers_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id) REFERENCES app.raster_snapshots(id);

-- Single-writer registry for data-schema tables; also the API's column metadata source
CREATE TABLE app.data_tables (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES app.integrations(id),
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.integration_versions
  ADD CONSTRAINT integration_versions_created_by_fk
  FOREIGN KEY (created_by) REFERENCES app.users(id);

CREATE TABLE app.auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_user_idx ON app.auth_sessions (user_id);

CREATE TABLE app.secrets (
  name text PRIMARY KEY,
  value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.dashboards (
  id text PRIMARY KEY,
  name text NOT NULL,
  current_version int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.dashboard_versions (
  dashboard_id text NOT NULL REFERENCES app.dashboards(id),
  version int NOT NULL,
  source text NOT NULL,
  queries jsonb NOT NULL,
  kit_version text NOT NULL,
  bundle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, version)
);

ALTER TABLE app.dashboards
  ADD CONSTRAINT dashboards_current_version_fk
  FOREIGN KEY (id, current_version) REFERENCES app.dashboard_versions(dashboard_id, version);

CREATE TABLE app.agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('designer', 'assistant', 'dashboard')),
  user_id uuid REFERENCES app.users(id),
  integration_id text REFERENCES app.integrations(id),
  dashboard_id text REFERENCES app.dashboards(id),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_state jsonb,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_sessions_user_idx ON app.agent_sessions (user_id, created_at DESC);

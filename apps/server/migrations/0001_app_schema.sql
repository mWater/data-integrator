-- Initial schema; docs/Database.md describes every table. The app/data split is
-- the security boundary: app holds the platform's own state and is never
-- granted to query roles; data holds integration output, readable by the
-- read-only sql_engine role that dashboards and the query assistant run as.
--
-- Run as the application's database user. Two steps need more privilege and
-- are done beforehand by a superuser when that user is not one (deploy/setup.sh
-- does both): CREATE EXTENSION postgis_raster, which is not a trusted
-- extension, and creating the sql_engine role, granted to the application
-- user WITH ADMIN OPTION.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS data;

-- ============================================================================
-- Integrations
-- ============================================================================

-- status: draft until a design session's cold run certifies it (library and
-- imported installs are ready at once). webhook_token is the capability URL
-- secret: senders POST to /hooks/<token>, so possession is authentication.
CREATE TABLE app.integrations (
  id text PRIMARY KEY,
  definition jsonb NOT NULL,
  version int NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  webhook_token uuid NOT NULL DEFAULT gen_random_uuid()
);

CREATE UNIQUE INDEX integrations_webhook_token_idx ON app.integrations (webhook_token);

-- Append-only archive of definition versions: lineage from runs stays
-- resolvable after edits, and the archive records who installed each version.
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

-- ============================================================================
-- Accounts
-- ============================================================================

-- ai_acknowledged_at: one-time acceptance that AI features send data to the
-- model provider; null until the user accepts the notice
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ai_acknowledged_at timestamptz
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

-- Personal access tokens: bearer credentials for the programmatic API. The
-- token itself is shown once at mint; only its SHA-256 is stored.
CREATE TABLE app.api_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX api_tokens_user_idx ON app.api_tokens (user_id, created_at DESC);

-- Per-integration secret values (AES-256-GCM envelope each), injected only
-- into that integration's runs, so a definition cannot receive a credential
-- by declaring another integration's secret name. Write-only over the API.
CREATE TABLE app.integration_secrets (
  integration_id text NOT NULL REFERENCES app.integrations(id) ON DELETE CASCADE,
  name text NOT NULL,
  value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, name)
);

CREATE TABLE app.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Dashboards
-- ============================================================================

-- public opens a dashboard's view surface to unauthenticated viewers; who
-- made it public and when is recorded. The id (slug) is renamable: every
-- reference cascades on update, and the circular current_version check
-- defers to commit because both sides change in the same statement.
CREATE TABLE app.dashboards (
  id text PRIMARY KEY,
  name text NOT NULL,
  current_version int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  public boolean NOT NULL DEFAULT false,
  published_by uuid REFERENCES app.users(id),
  published_at timestamptz
);

-- layers: raster catalog layers the version may draw, declared at save time
-- like its queries; the scoped tile route serves only declared layers
CREATE TABLE app.dashboard_versions (
  dashboard_id text NOT NULL REFERENCES app.dashboards(id) ON UPDATE CASCADE,
  version int NOT NULL,
  source text NOT NULL,
  queries jsonb NOT NULL,
  kit_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  bundle_js text NOT NULL,
  bundle_css text NOT NULL,
  layers jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (dashboard_id, version)
);

ALTER TABLE app.dashboards
  ADD CONSTRAINT dashboards_current_version_fk
  FOREIGN KEY (id, current_version) REFERENCES app.dashboard_versions(dashboard_id, version)
  DEFERRABLE INITIALLY DEFERRED;

-- ============================================================================
-- Agent sessions
-- ============================================================================

-- error: last loop error (model/provider failure), cleared on the next
-- successful step. locale: the UI locale at creation, which seeds the base
-- language of authored text; null for CLI sessions.
CREATE TABLE app.agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('designer', 'assistant', 'dashboard')),
  user_id uuid REFERENCES app.users(id),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_state jsonb,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error text,
  locale text
);

CREATE INDEX agent_sessions_user_idx ON app.agent_sessions (user_id, updated_at DESC);

-- Daily AI token usage per user (null: CLI sessions), counted against the
-- deployment's daily caps (aiLimits.ts). Days are UTC.
CREATE TABLE app.ai_usage (
  day date NOT NULL,
  user_id uuid REFERENCES app.users(id) ON DELETE CASCADE,
  tokens bigint NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX ai_usage_day_user ON app.ai_usage (day, user_id) NULLS NOT DISTINCT;

-- ============================================================================
-- Runs
-- ============================================================================

-- A run belongs to an installed integration, or to a design session whose
-- scratch area it runs in. attempt identifies one claim: the commit and the
-- heartbeat both check it, so a worker whose lease expired cannot apply
-- results after a replacement took the run over. file_pins ({ slotId:
-- versionId }) is fixed when the run is created. flags holds the validation
-- findings of a successful run.
CREATE TABLE app.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id text REFERENCES app.integrations(id),
  trigger text NOT NULL CHECK (trigger IN ('cron', 'webhook', 'manual', 'rebuild', 'agent')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout')),
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
  log text,
  session_id uuid REFERENCES app.agent_sessions(id),
  attempt uuid,
  file_pins jsonb,
  CONSTRAINT runs_owner_check CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL)
);

-- Which archived definition a run executed; unchecked while definition_version
-- is null (queued/failed runs, session scratch runs)
ALTER TABLE app.runs
  ADD CONSTRAINT runs_definition_version_fk
  FOREIGN KEY (integration_id, definition_version)
  REFERENCES app.integration_versions(integration_id, version);

CREATE INDEX runs_integration_idx ON app.runs (integration_id, scheduled_at DESC);
CREATE INDEX runs_queue_idx ON app.runs (scheduled_at) WHERE status = 'queued';
-- Serialization per integration and per session as constraints, not worker discipline
CREATE UNIQUE INDEX runs_one_running_idx ON app.runs (integration_id) WHERE status = 'running';
CREATE UNIQUE INDEX runs_one_queued_idx ON app.runs (integration_id) WHERE status = 'queued';
CREATE UNIQUE INDEX runs_one_running_session_idx ON app.runs (session_id)
  WHERE status = 'running' AND session_id IS NOT NULL;
CREATE UNIQUE INDEX runs_one_queued_session_idx ON app.runs (session_id)
  WHERE status = 'queued' AND session_id IS NOT NULL;

CREATE TABLE app.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id text NOT NULL REFERENCES app.integrations(id),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES app.runs(id)
);

CREATE INDEX webhook_events_pending_idx ON app.webhook_events (integration_id, received_at)
  WHERE run_id IS NULL;

-- ============================================================================
-- Raster catalog
-- ============================================================================

-- A layer belongs to an installed integration, or is a design session's
-- scratch preview. name is a LocalizedString. mask_geom is the shape tiles
-- are clipped to when drawn (rendering only; stored rasters are never cut),
-- null for none. retention_days is a time-series layer's history window,
-- null to keep every snapshot.
CREATE TABLE app.raster_layers (
  id text PRIMARY KEY,
  integration_id text REFERENCES app.integrations(id),
  name jsonb NOT NULL,
  temporality text NOT NULL CHECK (temporality IN ('time-series', 'current-only')),
  bands jsonb NOT NULL,
  current_snapshot_id uuid,
  session_id uuid REFERENCES app.agent_sessions(id),
  mask_geom geometry(MultiPolygon, 4326),
  retention_days integer,
  CONSTRAINT raster_layers_owner_check CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL)
);

-- A snapshot is a set of files (raster_sources): tiled products are stored as
-- their tiles and mosaicked at read time, and a snapshot with no files (and
-- no footprint) is a legitimate "nothing observed" publication. cell_size_m
-- is the approximate width of one cell in metres (lon/lat grids convert at
-- the equator), read from the files when the snapshot is stored.
CREATE TABLE app.raster_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id text NOT NULL REFERENCES app.raster_layers(id),
  observed_at timestamptz NOT NULL,
  observed_end timestamptz,
  footprint geometry(Polygon, 4326),
  crs text NOT NULL DEFAULT 'EPSG:4326',
  bands jsonb NOT NULL,
  size_bytes bigint,
  run_id uuid NOT NULL REFERENCES app.runs(id),
  status text NOT NULL CHECK (status IN ('promoted', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  cell_size_m double precision,
  metadata jsonb
);

CREATE INDEX raster_snapshots_layer_time_idx ON app.raster_snapshots (layer_id, observed_at DESC);

ALTER TABLE app.raster_layers
  ADD CONSTRAINT raster_layers_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id) REFERENCES app.raster_snapshots(id);

CREATE TABLE app.raster_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES app.raster_snapshots(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  path text NOT NULL,
  footprint geometry(Polygon, 4326) NOT NULL,
  size_bytes bigint,
  UNIQUE (snapshot_id, ordinal)
);

-- Single-writer registry for data-schema tables; also the API's column metadata source
CREATE TABLE app.data_tables (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES app.integrations(id),
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Integration files
-- ============================================================================

-- Uploaded file versions per declared slot (docs/Integration Files.md). Bytes
-- live in the file store at <id><ext>; a row whose bytes were purged keeps its
-- sha256 so lineage still resolves.
CREATE TABLE app.file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owning integration; null while a design session's upload waits for its
  -- draft row, which adopts it
  integration_id text REFERENCES app.integrations(id),
  -- Design session the file was attached in; null for integration-page uploads
  session_id uuid REFERENCES app.agent_sessions(id),
  slot_id text NOT NULL,
  version int NOT NULL,
  filename text NOT NULL,
  ext text NOT NULL CHECK (ext = '' OR ext ~ '^\.[a-z0-9]{1,10}$'),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_by uuid REFERENCES app.users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  purged_by text,
  CONSTRAINT file_versions_owner_check CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL)
);
-- Versions count up per slot of their owner: the integration once it owns
-- them, the session before that
CREATE UNIQUE INDEX file_versions_integration_idx ON app.file_versions (integration_id, slot_id, version)
  WHERE integration_id IS NOT NULL;
CREATE UNIQUE INDEX file_versions_session_idx ON app.file_versions (session_id, slot_id, version)
  WHERE integration_id IS NULL;

-- The version each slot of an integration uses when a run pins nothing; set
-- only by a successful production run's commit
CREATE TABLE app.file_slots (
  integration_id text NOT NULL REFERENCES app.integrations(id),
  slot_id text NOT NULL,
  current_version_id uuid NOT NULL REFERENCES app.file_versions(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, slot_id)
);

-- ============================================================================
-- Query surface (data schema)
-- ============================================================================

-- sql_engine: SELECT on data only, nothing on app. The application user is a
-- member so executors can SET LOCAL ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sql_engine') THEN
    CREATE ROLE sql_engine NOLOGIN;
  END IF;
  EXECUTE format('GRANT sql_engine TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA data TO sql_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA data GRANT SELECT ON TABLES TO sql_engine;

-- Promoted snapshots registered as tiled out-db PostGIS rasters referencing
-- the COG files in the raster store: pixels stay in the files, the database
-- holds tile-grid metadata, and SQL joins raster values against vector rows.
-- Out-db reads also need the settings below and a Postgres server process
-- that can read the raster store path.
CREATE TABLE data.rasters (
  layer_id text NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES app.raster_snapshots(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  observed_end timestamptz,
  rast raster NOT NULL
);

CREATE INDEX rasters_layer_time_idx ON data.rasters (layer_id, observed_at);
CREATE INDEX rasters_snapshot_idx ON data.rasters (snapshot_id);
CREATE INDEX rasters_spatial_idx ON data.rasters USING gist (ST_ConvexHull(rast));

-- Superuser settings: database owners can often set them; when not, the
-- deploy script's superuser step is authoritative
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET postgis.enable_outdb_rasters = on', current_database());
  EXECUTE format('ALTER DATABASE %I SET postgis.gdal_enabled_drivers = %L', current_database(), 'ENABLE_ALL');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not enable out-db raster settings; run as superuser: ALTER DATABASE % SET postgis.enable_outdb_rasters = on; ALTER DATABASE % SET postgis.gdal_enabled_drivers = ''ENABLE_ALL'';', current_database(), current_database();
END
$$;

-- The deployment's area of interest as a real shape, not a box. Integrations
-- fetch by bounding box (a download window), but any statistic that claims to
-- be "of the country" is taken over this polygon: land only, lakes removed.
-- One row, rebuilt from the default_aoi setting by the server.
CREATE TABLE data.aoi (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text,
  countries text[] NOT NULL DEFAULT '{}',
  bbox float8[] NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  land_area_km2 float8 NOT NULL,
  boundary_source text NOT NULL,
  boundary_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Area-weighted statistics of one raster layer over the area of interest.
--   layer_id   the layer (data.rasters.layer_id)
--   at         the date to report on: the latest snapshot starting on or
--              before it (null means the newest snapshot)
--   threshold  with op, the condition whose share of the area is reported
--              (e.g. threshold -1, op '<' gives the share in drought)
--   op         one of < <= > >= =
--   band       band index, 1-based
-- Returns one row: mean (area-weighted), share (area meeting the condition,
-- null without a threshold), coverage (share of the area's land with a
-- valid pixel), cells (valid pixels counted), cell_km2 (pixel area at the
-- area's centre), method ('exact' when each pixel is weighted by the part of
-- it inside the boundary, 'clip' when pixels are fine enough that whole-pixel
-- clipping is within a fraction of a percent; pixels are then weighted by
-- their area at their own latitude, in strips of at most half a degree),
-- observed_at and observed_end of the snapshot used, and boundary (source
-- and version of the shape). Nodata and NaN pixels are never counted.
-- SECURITY DEFINER so the read-only role can reach the layer's declared
-- nodata in app.raster_layers.
CREATE OR REPLACE FUNCTION data.aoi_stats(
  layer_id text,
  at timestamptz DEFAULT NULL,
  threshold float8 DEFAULT NULL,
  op text DEFAULT '<',
  band integer DEFAULT 1
) RETURNS TABLE (
  mean float8,
  share float8,
  coverage float8,
  cells bigint,
  cell_km2 float8,
  method text,
  observed_at timestamptz,
  observed_end timestamptz,
  boundary text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = data, public
AS $$
DECLARE
  aoi_geom geometry;
  aoi_km2 float8;
  aoi_boundary text;
  obs_at timestamptz;
  obs_end timestamptz;
  declared_nodata float8;
  px_w float8;
  px_h float8;
  cx float8;
  cy float8;
  px_km2 float8;
  est_cells float8;
  strip_rows integer;
  -- Above this many pixels, exact per-pixel intersection is too slow for an
  -- interactive query, and the whole-pixel error is already negligible
  exact_limit constant float8 := 25000;
BEGIN
  IF op NOT IN ('<', '<=', '>', '>=', '=') THEN
    RAISE EXCEPTION 'aoi_stats: op must be one of < <= > >= =, got %', op;
  END IF;

  SELECT a.geom, a.land_area_km2, a.boundary_source || ' ' || a.boundary_version
    INTO aoi_geom, aoi_km2, aoi_boundary
  FROM data.aoi a;
  IF aoi_geom IS NULL THEN
    RAISE EXCEPTION 'aoi_stats: no area of interest is configured for this deployment';
  END IF;

  SELECT r.observed_at, r.observed_end INTO obs_at, obs_end
  FROM data.rasters r
  WHERE r.layer_id = aoi_stats.layer_id
    AND (aoi_stats.at IS NULL OR r.observed_at <= aoi_stats.at)
  ORDER BY r.observed_at DESC
  LIMIT 1;
  IF obs_at IS NULL THEN
    -- Nothing on or before the date: the earliest snapshot is the honest answer
    SELECT r.observed_at, r.observed_end INTO obs_at, obs_end
    FROM data.rasters r WHERE r.layer_id = aoi_stats.layer_id
    ORDER BY r.observed_at ASC LIMIT 1;
  END IF;
  IF obs_at IS NULL THEN
    RAISE EXCEPTION 'aoi_stats: layer % has no registered snapshots', aoi_stats.layer_id;
  END IF;

  SELECT (b ->> 'nodata')::float8 INTO declared_nodata
  FROM app.raster_layers l, jsonb_array_elements(l.bands) WITH ORDINALITY AS t(b, i)
  WHERE l.id = aoi_stats.layer_id AND t.i = aoi_stats.band;

  SELECT abs(ST_PixelWidth(r.rast)), abs(ST_PixelHeight(r.rast)) INTO px_w, px_h
  FROM data.rasters r
  WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
  LIMIT 1;
  SELECT ST_X(c), ST_Y(c) INTO cx, cy FROM (SELECT ST_Centroid(aoi_geom) AS c) s;
  px_km2 := ST_Area(ST_MakeEnvelope(cx, cy, cx + px_w, cy + px_h, 4326)::geography) / 1e6;
  est_cells := ST_Area(aoi_geom::geography) / 1e6 / px_km2;

  IF est_cells <= exact_limit THEN
    RETURN QUERY
    WITH tiles AS (
      SELECT CASE
               WHEN ST_BandNoDataValue(r.rast, aoi_stats.band) IS NULL AND declared_nodata IS NOT NULL
               THEN ST_SetBandNoDataValue(r.rast, aoi_stats.band, declared_nodata)
               ELSE r.rast
             END AS rast
      FROM data.rasters r
      WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
        AND ST_Intersects(ST_ConvexHull(r.rast), aoi_geom)
    ),
    -- Every pixel whose square touches the boundary counts, weighted by the
    -- part inside; ST_Clip would keep only pixels whose centre is inside and
    -- drop the coastal half-cells
    px AS (
      SELECT (pp).val AS val, (pp).geom AS geom
      FROM tiles t, LATERAL ST_PixelAsPolygons(t.rast, aoi_stats.band, true) pp
      WHERE ST_Intersects((pp).geom, aoi_geom)
    ),
    weighted AS (
      SELECT p.val, ST_Area(ST_Intersection(p.geom, aoi_geom)::geography) / 1e6 AS km2
      FROM px p
      WHERE p.val = p.val AND p.val IS NOT NULL AND (declared_nodata IS NULL OR p.val <> declared_nodata)
    )
    SELECT
      sum(w.val * w.km2) / NULLIF(sum(w.km2), 0),
      CASE WHEN threshold IS NULL THEN NULL ELSE
        sum(w.km2) FILTER (WHERE
          (op = '<'  AND w.val <  threshold) OR (op = '<=' AND w.val <= threshold) OR
          (op = '>'  AND w.val >  threshold) OR (op = '>=' AND w.val >= threshold) OR
          (op = '='  AND w.val =  threshold)) / NULLIF(sum(w.km2), 0)
      END,
      sum(w.km2) / aoi_km2,
      count(*)::bigint,
      px_km2,
      'exact'::text,
      obs_at,
      obs_end,
      aoi_boundary
    FROM weighted w
    WHERE w.km2 > 0;
  ELSE
    -- Whole pixels, but a lat/lon pixel near the equator is larger than one
    -- near the pole: cut each clipped tile into strips no taller than half a
    -- degree and weight every strip's pixels by the cell area at its latitude
    strip_rows := greatest(1, floor(0.5 / px_h))::integer;
    RETURN QUERY
    WITH tiles AS (
      SELECT ST_Clip(
               CASE
                 WHEN ST_BandNoDataValue(r.rast, aoi_stats.band) IS NULL AND declared_nodata IS NOT NULL
                 THEN ST_SetBandNoDataValue(r.rast, aoi_stats.band, declared_nodata)
                 ELSE r.rast
               END, aoi_stats.band, aoi_geom, true) AS rast
      FROM data.rasters r
      WHERE r.layer_id = aoi_stats.layer_id AND r.observed_at = obs_at
        AND ST_Intersects(ST_ConvexHull(r.rast), aoi_geom)
    ),
    strips AS (
      SELECT s.rast, ST_Y(ST_Centroid(ST_Envelope(s.rast))) AS lat
      FROM tiles t, LATERAL ST_Tile(t.rast, 1, ST_Width(t.rast), strip_rows) s(rast)
      WHERE NOT ST_IsEmpty(t.rast)
    ),
    stats AS (
      SELECT (ST_SummaryStats(s.rast, 1, true)).count AS n,
             (ST_SummaryStats(s.rast, 1, true)).mean AS m,
             -- The hit raster keeps the input's nodata value, which an 8-bit
             -- band clamps to 0 (a miss): declare 255 as nodata explicitly
             CASE WHEN threshold IS NULL THEN NULL ELSE
               (ST_SummaryStats(ST_SetBandNoDataValue(ST_MapAlgebra(s.rast, 1, '8BUI',
                  format('CASE WHEN [rast] %s %s THEN 1 ELSE 0 END', op, threshold), 255), 1, 255), 1, true)).mean
             END AS hit,
             ST_Area(ST_MakeEnvelope(0, s.lat - px_h / 2, px_w, s.lat + px_h / 2, 4326)::geography) / 1e6 AS km2
      FROM strips s
    )
    SELECT
      sum(s.m * s.n * s.km2) / NULLIF(sum(s.n * s.km2), 0),
      CASE WHEN threshold IS NULL THEN NULL ELSE sum(s.hit * s.n * s.km2) / NULLIF(sum(s.n * s.km2), 0) END,
      sum(s.n * s.km2) / aoi_km2,
      sum(s.n)::bigint,
      px_km2,
      'clip'::text,
      obs_at,
      obs_end,
      aoi_boundary
    FROM stats s;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION data.aoi_stats(text, timestamptz, float8, text, integer) TO sql_engine;

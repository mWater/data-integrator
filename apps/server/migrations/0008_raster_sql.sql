-- Rasters become first-class citizens of the query surface: promoted
-- snapshots are registered as tiled OUT-DB PostGIS rasters referencing the
-- COG files in the raster store (pixels stay in the files; the database holds
-- only tile-grid metadata). SQL can then join raster values against vector
-- rows: ST_Value at features, ST_SummaryStats over clipped buffers, and
-- anything else composable — under the same read-only sql_engine role as
-- tables.
--
-- Out-db reads require, beyond this migration:
--   - postgis.enable_outdb_rasters = on and postgis.gdal_enabled_drivers set
--     (superuser settings; attempted below, warning if not permitted — the
--     deploy script sets them as postgres)
--   - the Postgres server process able to read the raster store path
CREATE EXTENSION IF NOT EXISTS postgis_raster;

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

-- Best effort: database owners can often set these; when not, the deploy
-- script's superuser step is authoritative
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET postgis.enable_outdb_rasters = on', current_database());
  EXECUTE format('ALTER DATABASE %I SET postgis.gdal_enabled_drivers = %L', current_database(), 'ENABLE_ALL');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not enable out-db raster settings; run as superuser: ALTER DATABASE % SET postgis.enable_outdb_rasters = on; ALTER DATABASE % SET postgis.gdal_enabled_drivers = ''ENABLE_ALL'';', current_database(), current_database();
END
$$;

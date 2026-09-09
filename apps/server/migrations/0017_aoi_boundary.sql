-- The deployment's area of interest as a real shape, not a box. Integrations
-- still fetch by bounding box (a download window), but any statistic that
-- claims to be "of the country" must be taken over this polygon: land only,
-- lakes removed, and coarse pixels weighted by the part of each that lies
-- inside. One row, rebuilt from the default_aoi setting by the server.
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
GRANT SELECT ON data.aoi TO sql_engine;

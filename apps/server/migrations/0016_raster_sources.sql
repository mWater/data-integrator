-- A snapshot is a set of files, not one file: tiled products (10-degree flood
-- tiles, per-country population grids) are stored as their tiles and
-- mosaicked at read time, and a snapshot with no files is a legitimate
-- "nothing observed" publication that supersedes the previous one.
CREATE TABLE app.raster_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES app.raster_snapshots(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  path text NOT NULL,
  footprint geometry(Polygon, 4326) NOT NULL,
  size_bytes bigint,
  UNIQUE (snapshot_id, ordinal)
);

INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint, size_bytes)
  SELECT id, 0, path, footprint, size_bytes FROM app.raster_snapshots;

ALTER TABLE app.raster_snapshots
  DROP COLUMN path,
  ALTER COLUMN footprint DROP NOT NULL;

-- A layer's map mask: the shape its tiles are clipped to when drawn, derived
-- from the owning integration's effective area of interest (inherited
-- deployment default, or the integration's own countries). Null means no
-- mask: an explicit box or the source's full extent shows everything the
-- integration fetched. Rendering only; stored rasters are never cut.
ALTER TABLE app.raster_layers
  ADD COLUMN mask_geom geometry(MultiPolygon, 4326);

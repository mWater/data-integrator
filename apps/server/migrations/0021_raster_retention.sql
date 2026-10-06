-- History window of a time-series layer, copied from its destination's
-- retention.days at install; NULL keeps every snapshot. Snapshots observed
-- before the window, and superseded snapshots of any layer, are deleted by
-- the retention sweep (rows, store files, tile cache).
ALTER TABLE app.raster_layers ADD COLUMN retention_days integer;

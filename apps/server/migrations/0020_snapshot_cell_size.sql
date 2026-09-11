-- Approximate width of one cell in metres, read from the files when a
-- snapshot is stored (the STAC "gsd"), so readers never open a file to
-- learn a layer's resolution. Lon/lat grids convert at the equator.
-- Existing promoted snapshots: run `cli.js backfill-cell-sizes` once.
ALTER TABLE app.raster_snapshots ADD COLUMN cell_size_m double precision;

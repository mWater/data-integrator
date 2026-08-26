# Copernicus DEM GLO-30

## Prompt

> Connect the Copernicus global digital elevation model at 30 m (GLO-30).
> Static: ingest once for the deployment's area of interest as a
> current-only raster layer named "Elevation", in metres above sea level.
> The source is tiled, so mosaic the tiles covering the area of interest.
> No schedule.

## Scope

- GLO-30 from the AWS open-data mirror (public, no account), 1x1 degree
  COG tiles.
- Current-only; terrain rarely changes. FABDEM (bare-earth variant) is
  parked on licensing; this entry carries terrain for catchment and
  drainage work.
- Derived products (slope, flow accumulation) are later derived
  integrations.

## Acceptance checks

- Mosaic is seamless across tile boundaries (no stripes at 1-degree lines).
- Elevation at a known summit and at the coast within tens of metres of
  reference values; sea is ~0 or nodata.
- Units metres; nodata declared; CRS recorded.

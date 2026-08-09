---
name: WorldPop population source
description: How WorldPop publishes gridded population - per-country files by ISO3, product variants, URL layout
verified: 2026-08-09
---

# WorldPop gridded population

University of Southampton population rasters, one file per country per
year. License CC-BY-4.0. Catalog: https://hub.worldpop.org (the data files
themselves come from `data.worldpop.org`).

## File layout

WorldPop is **country-keyed, not extent-keyed**: you download a country's
file by ISO 3166-1 alpha-3 code, not a spatial window. The UN-adjusted 1km
unconstrained series used by the library entry:

    https://data.worldpop.org/GIS/Population/Global_2000_2020_1km_UNadj/2020/{ISO3}/{iso3_lower}_ppp_2020_1km_Aggregated_UNadj.tif

- `{ISO3}` uppercase in the directory, lowercase in the filename.
- Years 2000-2020 in this series; sibling series vary by resolution
  (100m native vs 1km aggregated), constrained vs unconstrained, and
  UN-adjusted vs raw. Ask the user which variant when it matters.
- Values are people per pixel (sum over an area = population). EPSG:4326.
  Nodata is a large negative sentinel — read it from the file.

## Choosing the country

Take the ISO3 from the AOI: `ctx.definition.aoi.countries` carries the
codes when the AOI came from a country selection (deployment default or
picker). Fall back to asking the user; never guess from the bbox.

## Ingestion pattern

The proven shape (see `library/integrations/worldpop_population`):

- Static/annual data: a **current-only** raster layer, replaced on ingest,
  not a time series.
- Cache the country file in /work (atomic `.part` rename); re-runs then
  only re-clip.
- Clip to the AOI bbox and convert to COG with `gdal_translate -projwin`
  (upper-left then lower-right: west north east south), RESAMPLING=NEAREST
  to keep counts unsmoothed.
- Population rasters double as analysis masks: population-weighted zonal
  statistics over a bbox largely self-correct for ocean and empty areas
  (see `library/integrations/rainfall_stats`).

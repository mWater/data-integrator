---
name: CHIRPS rainfall source
description: How CHIRPS v2.0 publishes rainfall rasters - URL layout, gzip GeoTIFFs, publication lag, clipping
verified: 2026-08-09
---

# CHIRPS v2.0 rainfall

Climate Hazards Center (UC Santa Barbara) gridded precipitation, blending
station data and satellite estimates. License CC-BY-4.0. Reference:
https://data.chc.ucsb.edu/products/CHIRPS-2.0/README-CHIRPS.txt

## File layout

Products live under `https://data.chc.ucsb.edu/products/CHIRPS-2.0/`, one
directory per product. The Africa monthly product used by the library entry:

    https://data.chc.ucsb.edu/products/CHIRPS-2.0/africa_monthly/tifs/chirps-v2.0.{year}.{month:02d}.tif.gz

- Files are **gzip-compressed GeoTIFFs**. Stream-decompress on download
  (`gzip.open(response.raw)` with `requests` stream=True) instead of saving
  the .gz and re-reading.
- Africa monthly: 0.05 degree grid, EPSG:4326, units mm/month.
- Nodata is -9999 (read it from the file rather than hardcoding).
- Global monthly/daily, pentad, and preliminary products sit under sibling
  directories with analogous naming when a wider extent or faster updates
  are needed.

## Publication lag

Final monthly files appear with a lag of several weeks after month end. A
**404 for a recent month means "not published yet", not an error** — stop
the loop there and pick the month up on a later run. Never fail the run on
a trailing 404.

## Ingestion pattern

The proven shape:

- Cursor state `{last_month: "YYYY-MM"}` in previousState; resume at the
  next month, stop at the current month or first 404.
- Cap months per run (12 works well) so a long backfill makes progress
  within the job timeout; the next scheduled run continues.
- First run backfills a default window; declare it as a `months_back`
  setting (`appliesOn: "rebuild"`) so operators can deepen it.
- Cache raw downloads in /work (atomic: download to `.part`, rename).
- Clip to the AOI and convert to COG in one step:
  `gdal_translate -projwin <west> <north> <east> <south> -of COG -co COMPRESS=DEFLATE`.
  **-projwin takes upper-left then lower-right (west north east south)** —
  not the bbox order (west south east north).
- One raster artifact per month with `timestamp`/`timestampEnd` spanning the
  month, on a time-series layer.

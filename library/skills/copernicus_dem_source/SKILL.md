---
name: Copernicus DEM source
description: How Copernicus DEM GLO-30/GLO-90 publishes elevation tiles - AWS mirror layout, tile naming, ocean 404s, DSM semantics, vertical datum
verified: 2026-08-26
---

# Copernicus DEM (GLO-30 / GLO-90)

ESA's global elevation model. GLO-30 is 30 m (1 arcsec), GLO-90 is 90 m.
Free to use with attribution (ESA/Airbus license terms); unlike FABDEM
(CC BY-NC-SA, non-commercial - a licensing decision before it can ship),
GLO-30 is unencumbered.

## AWS open-data mirror

No account, plain HTTPS, one COG per 1x1 degree cell:

    https://copernicus-dem-30m.s3.amazonaws.com/
      Copernicus_DSM_COG_10_S19_00_E047_00_DEM/
        Copernicus_DSM_COG_10_S19_00_E047_00_DEM.tif

- Naming: `Copernicus_DSM_COG_10_{NS}{lat:02d}_00_{EW}{lon:03d}_00_DEM`,
  where lat/lon are the cell's lower-left corner. GLO-90 swaps `_10_` for
  `_30_` in the `copernicus-dem-90m` bucket.
- **Ocean-only cells are not published: a 404 means "no land here", not an
  error.** Enumerate the AOI's cells and skip 404s.
- Tiles are already COGs in EPSG:4326; a VRT over the downloaded tiles plus
  one gdalwarp clip is the whole mosaic step (see cog_output for the COG
  driver's working-directory trap).

## Data semantics

- It is a **digital surface model** (buildings and canopy included), edited
  for artifacts. Not bare earth; say so in the description rather than
  implying terrain.
- Heights are metres, **orthometric (EGM2008 geoid)**, so "metres above sea
  level" is the right label.
- **Sea is 0, and the source declares no nodata.** Choose a sentinel
  (-9999 is the proven choice), pass it as -dstnodata for areas outside the
  clip, and declare it on the band. Do not treat 0 as missing: coastal land
  at sea level is real.
- Float32; expect values roughly -100..9000 globally.

## Ingestion pattern

The proven shape (see `library/integrations/copernicus_dem_glo30`): static
source, manual trigger, current-only layer. Download the AOI's tiles in
parallel to /work (atomic .part rename, validate each with rasterio before
trusting the cache), gdalbuildvrt, one gdalwarp to clip and stamp nodata,
COG out. Snapshot timestamp: the release date, not run time. Verify against
known elevations (a named summit, a coastal city) before shipping.

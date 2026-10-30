---
name: Sparse raster overviews
description: Technique - COG overview resampling for sparse data; nearest erases sparse masks, average inflates sparse counts; explicit max-pooled pyramids
verified: 2026-08-27
---

# Overview resampling for sparse rasters

A COG's overview pyramid decides what the map shows at low zoom. GDAL's
default resamplers are built for dense continuous imagery and silently
destroy sparse data - and the damage only appears when someone zooms out,
after everything else validates.

## The two failure modes

- **Nearest erases sparse masks.** A binary flood/burn/detection mask where
  1-pixels are rare loses nearly all of them under nearest decimation: each
  overview pixel keeps one arbitrary source pixel, and the odds it is a
  1-pixel shrink by 4x per level. Measured on a 20 m flood mask: 156,000
  flood pixels at full resolution, 9 at overview level 5, 0 at level 7 -
  the country-zoom map looked blank on the heaviest flood day of the month.
- **Average inflates sparse counts.** For count-per-cell rasters with large
  nodata seas, averaging pulls values toward zero where nodata is excluded
  unevenly, and smears isolated hotspots into broad haloes that read as
  data where there is none. Use nearest only if per-pixel fidelity at zoom
  matters more than visibility - the two traps are opposites, so pick per
  dataset, never by habit.

## What to do for categorical/sparse masks

Build the pyramid yourself with max pooling, then hand it to GDAL:

1. Recursively pool 2x2 windows per level: **1 if any input pixel is 1;
   else 0 if any input pixel is observed; else nodata.** The precedence
   keeps rare positives visible at every zoom and keeps observed-vs-nodata
   honest.
2. GDAL may not offer MAX overview resampling. Attach the precomputed
   levels to a VRT (or .ovr) and create the COG with
   `OVERVIEWS=FORCE_USE_EXISTING` so gdal_translate copies your pyramid
   instead of regenerating it.
3. **Validate the pyramid, not just the base raster**: read every internal
   overview level back and count the classes. Fail the run if a level that
   should carry positives has none. Zoomed-out blankness is exactly the
   defect a full-resolution check cannot catch.

Related: when re-encoding an existing COG, `gdal_translate` copies the old
overviews unless told `OVERVIEWS=IGNORE_EXISTING` - fixing the base pixels
does not fix a poisoned pyramid.

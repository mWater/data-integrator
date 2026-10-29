---
name: WorldPop population source
description: How WorldPop publishes gridded population - country-keyed files, Global 2015-2030 release layout, constrained variant, encoding pitfalls
verified: 2026-09-11
---

# WorldPop gridded population

University of Southampton population rasters, one file per country per
year. License CC-BY-4.0. Catalog API: `https://hub.worldpop.org/rest/data/pop`
(discover the newest release there rather than pinning one); data files
come from `data.worldpop.org`.

## File layout

WorldPop is **country-keyed, not extent-keyed**: you download a country's
file by ISO 3166-1 alpha-3 code, not a spatial window. The current
Global Demographic Data series (annual 2015-2030, revised releases):

    https://data.worldpop.org/GIS/Population/Global_2015_2030/{RELEASE}/{year}/{ISO3}/v1/100m/constrained/{iso3}_pop_{year}_CN_100m_{RELEASE}_v1.tif

- `{RELEASE}` like `R2025A`; `{ISO3}` uppercase in the path, lowercase in
  the filename; `CN` = constrained (also `UC` unconstrained).
- **Constrained** places population only on detected settlement - the
  variant coverage/facility analysis needs. Unconstrained smears people
  across empty land.
- Years past the current calendar year are modeled projections, not
  observations; releases are revised (newer R-series supersede), and
  recent releases may be flagged alpha. Say both in source.limitations.
- Values are people per pixel (float32; sum over an area = population),
  EPSG:4326, nodata a large negative sentinel - read it from the file.
- UN-adjusted totals track UN WPP: a country-sum within ~1-2% of the UN
  figure is the acceptance check (Madagascar 2026: 33.1M vs WPP ~32.7M).

## Choosing the country

Take ISO3 codes from the runtime AOI (`aoi.countries`) so the entry stays
portable across deployments. Never
guess countries from the bbox alone: a bare-box AOI is an error to report,
not a puzzle to solve. Never substitute a built-in example country when no
AOI is present - no AOI means the whole world (below).

## The whole world

No AOI = every country in the release (the release listing
`rest/data/pop/{RELEASE}` gives the ISO3 set per year in one request; file
URLs still need the per-country query). Do not mosaic: a global mosaic is
432,000 x 216,000 pixels. Re-encode each country file to its own COG and
return the year as one snapshot with `sources: [{path, footprint}]`
(~240 files). Per year: ~10 GB of downloads (USA 1.5 GB, CHN 0.9, IND 0.8),
~3.5 GB stored as COGs, so default to the current year and declare a
`years` choice setting (automatic / every published year / current year) to
widen it. Cache finished COGs in /work per release+year and
delete each source download once its COG exists, so an interrupted year
resumes and disk stays near the stored size. Retry HTTP calls: the hub and
data servers drop connections mid-run.

Border double counting is not an issue: WorldPop assigns every cell to
exactly one country before cutting the per-country files, so extents
overlap but valid pixels never do (verified RWA/BDI 2025: 0 shared cells
in a 635-row overlap band). Meta/HDX HRSL tiles, by contrast, are buffered
and do overlap.

## Encoding pitfalls (both hit for real)

- `PREDICTOR=FLOATING_POINT` inflates this sparse data ~57% versus
  `PREDICTOR=NO` - measure, don't assume (see the COG output skill).
- Build overviews with NEAREST. Averaged overviews bleed the -99999
  sentinel into settlement edges, and approx statistics (which read
  overviews) then report impossible negative population - if min < 0
  shows up in stats, suspect the pyramid, not the source.

## Ingestion pattern

Annual series -> **time-series** layer, one snapshot per year (Jan 1
instants), monthly cron to catch new years/releases; cursor per the
incremental ingestion skill. Cache country files in /work keyed by
release+year; clip to the AOI with one gdalwarp to COG.

# fAPAR anomaly (GDO)

## Prompt

> Connect the fAPAR anomaly from the Copernicus Global Drought Observatory as
> a ten-daily time-series raster layer named "fAPAR anomaly", dimensionless,
> for the deployment's area of interest. Backfill the last two years, then
> keep it current every ten days. Negative values mean vegetation is doing
> worse than usual, so style it diverging around zero (brown to green).

## Scope

- GDO VIIRS product (the MODIS series ended in 2022). Native ten-daily
  cadence is kept: every dekad becomes a snapshot with its period as
  timestamp/timestampEnd, unlike the SPI-3 entry which picks one dekad a
  month.
- 0.083 degree global grid; yearly NetCDF files of ~170 MB, cached in /work.
- Companion to the SPI-3 entry: rainfall deficit plus vegetation response is
  the standard early-warning pair for agricultural drought.

## Acceptance checks

- Three snapshots per month across the backfill window; the newest matches
  the source's advertised latest dekad.
- Values roughly in [-4, 4] in the AOI; a known dry season reads negative
  over rain-fed cropland and near zero over evergreen forest.
- Nodata -9999 declared and in the COG; ocean nodata; diverging ramp white
  at 0.

## Record

Hand-authored from the gdo_drought_source skill on 2026-09-05 (second GDO
entry; the layout was already known), not from a design session.

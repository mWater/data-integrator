# SPI (Standardized Precipitation Index)

## Prompt

> Connect the Standardized Precipitation Index from the Copernicus
> European/Global Drought Observatory. I want the 3-month accumulation
> (SPI-3) as a monthly time-series raster layer named "SPI-3 drought
> index", dimensionless, for the deployment's area of interest. Backfill
> the last two years, then keep it current monthly. Values below -1
> indicate drought, so make the map styling diverge around zero.

## Scope

- GDO/JRC public SPI grids. SPI-3 is the drought-monitoring workhorse;
  other accumulations (1, 6, 12) can be later entries.
- First incremental time-series prompt in the set: exercises previousState
  cursors, backfill, and publication lag on a dekadal source.
- Alternative if GDO access proves awkward: compute SPI from CHIRPS as a
  derived integration. That is a scope change; record it if taken.

## Acceptance checks

- Monthly snapshots present for the backfill window; freshness matches the
  declared cadence.
- Values roughly in [-3, 3]; a known recent drought month in the AOI shows
  negative values where expected.
- Nodata declared; diverging color ramp centred on 0.

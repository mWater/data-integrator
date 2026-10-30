# Agricultural drought risk (GDO RDrI-Agri)

## Prompt

> Connect the Combined Drought Indicator from the Copernicus drought
> observatories as a ten-daily time-series raster layer for the deployment's
> area of interest, backfilling two years and keeping it current.

## Scope

- The Combined Drought Indicator (CDI) exists only for Europe (EDO). The
  Global Drought Observatory's equivalent is the Risk of Drought Impacts for
  Agriculture (RDrI-Agri): SPI, soil moisture anomaly and fAPAR anomaly
  combined with exposure and vulnerability into classes 0 (none) to 3
  (high), ten-daily on a 1 degree grid. This entry ingests RDrI-Agri and
  says so in its name and description; the CDI is not a global product.
- Categorical data: nearest resampling and nearest overviews, one colour per
  class, class 0 nearly transparent so risk stands out on the map.

## Acceptance checks

- Three snapshots per month across the backfill window.
- Only the values 0, 1, 2, 3 occur; ocean is nodata.
- A recent drought period in the AOI shows medium/high cells where the SPI-3
  and fAPAR anomaly layers both read dry.

## Record

Hand-authored from the gdo_drought_source skill on 2026-09-05, not from a
design session.

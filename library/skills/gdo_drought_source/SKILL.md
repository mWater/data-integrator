---
name: GDO drought source
description: Copernicus Global Drought Observatory datasets - directory layout, version discovery, GPCC vs ERA5 variants, NetCDF conventions, SPI semantics
verified: 2026-09-10
---

# Copernicus Global Drought Observatory (GDO/EDO)

Drought indicators from the JRC's Drought Observatories: SPI at several
accumulations, soil moisture anomaly, fAPAR anomaly, the Combined Drought
Indicator, and more. Public plain-HTTPS directory listing, no account,
CC BY 4.0 (record the attribution).

## Directory layout

    https://drought.emergency.copernicus.eu/data/Drought_Observatories_datasets/

One directory per dataset, e.g. `GDO_GPCC_Standardized_Precipitation_Index_SPI3/`,
containing versioned subdirectories (`ver1-2-0/`). **Discover the newest
version at run time** by scraping `href="(ver\d+(?:-\d+)+/)"` from the
dataset index and sorting numerically - versions do bump, and pinning one
breaks silently later.

Inside, yearly world NetCDF files named like:

    spg03_m_wld_20240101_20241201_m.nc

`<var>_<cadence>_wld_<firstdate>_<lastdate>_<cadence>.nc`. The current
year's file is partial and its name advertises the last month present -
parse both dates from the filename to know what a file covers **without
downloading it**. Incremental runs: fetch only files whose advertised end
date is newer than the cursor.

## Variants: pick by cadence

- `GDO_GPCC_...` - GPCC-precipitation-based, **natively monthly**, global
  1 degree, reference period 1981-2010. The right default when the ask is
  monthly; coarse (a country AOI is only a handful of cells).
- `GDO_ERA5_...` - ERA5-based, dekadal (three per month), global 0.25
  degree (verified: `ver2-0-0/spa03_m_gdo_YYYY0101_YYYYMMDD_t.nc` - note
  the different prefix and `_t` suffix vs GPCC's `_m`). Use when resolution
  matters more than native-monthly semantics, but you must then choose one
  dekad per month (e.g. the 21st-day dekad as the month's value) - that is
  a scope decision to surface, not bury.

## Data conventions

- NetCDF opens with xarray; one data variable named like the file prefix
  (`spg03`), dims time/lat/lon, monthly timestamps on the first of month.
- SPI is dimensionless, nominal range [-3, 3] but **legitimate extremes
  exceed it** (observed -4.4); do not clamp or assert +-3. Below -1 means
  drought. Style with a diverging ramp, white at 0, a visible break at -1.
- Declare nodata explicitly (write and declare the same value, e.g. -9999);
  ocean/missing cells are NaN in the source.
- Publication lags roughly a month; a monthly check offset into the month
  (e.g. the 10th) reliably finds the newest file.

## Other GDO datasets (same layout, ten-daily)

All follow `<var>_m_gdo_<firstdate>_<lastdate>_t.nc` with dates naming the
first and last dekad in the file (dekads start on the 1st, 11th, 21st):

- `GDO_Fraction_of_Absorbed_Photosynthetically_Active_Radiation_Anomalies_fAPAR_VIIRS/`
  - variable `fpanv`, 0.083 degree, lat 90 to -56; ~170 MB per year. Use
  VIIRS: the MODIS series (`fapan`, `_wld_` files) stopped in 2022.
- `GDO_Risk_of_Drought_Impacts_for_Agriculture/` - variable `rdria`, 1
  degree, classes 0 none / 1 low / 2 medium / 3 high (categorical: nearest
  resampling). This is the global stand-in for the Combined Drought
  Indicator, which exists only for Europe (`EDO_Combined_Drought_Indicator/`).
- `GDO_Soil_Moisture_Index_Anomaly/` - variable `smang`, **0.05 degree**
  (7200x3000, lat 90 to -60, descending), LISFLOOD/GloFAS 4 modelled
  root-zone soil moisture standardized against 1995-2023; ~480 MB per year
  of dekads, a global dekad is 86 MB in memory. Contains numerical blow-ups
  (|z| up to 1e6 over ice sheets and hyper-arid deserts, ~0.5% of land):
  mask |z| > 10 as nodata or zonal means are ruined. Publication lags two to
  three weeks. `GDO_Ensemble_Soil_Moisture_Anomaly/` (`smand`, the older
  three-source ensemble) stopped in mid-2024; do not use it.

Keeping every dekad is the natural cadence for these; a snapshot's period is
the dekad start to the next dekad start (`timestampEnd`).

## The productCfg endpoint

`https://drought.emergency.copernicus.eu/services/productCfg?app=download`
returns JSON describing every downloadable product - useful for
discovering dataset directory names for other indicators.

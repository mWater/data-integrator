---
name: GDO drought source
description: Copernicus Global Drought Observatory datasets - directory layout, version discovery, GPCC vs ERA5 variants, NetCDF conventions, SPI semantics
verified: 2026-08-26
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

## The productCfg endpoint

`https://drought.emergency.copernicus.eu/services/productCfg?app=download`
returns JSON describing every downloadable product - useful for
discovering dataset directory names for other indicators.

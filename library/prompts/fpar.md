# FPAR vegetation productivity

## Prompt

> Connect FPAR (fraction of absorbed photosynthetically active radiation)
> from the Copernicus Land Monitoring Service as a 10-daily time-series
> raster layer named "Vegetation productivity (FPAR)", dimensionless 0-1,
> for the deployment's area of interest. Backfill six months and keep it
> current. Credentials are in the secret named clms_credentials.

## Scope

- CLMS 300 m FPAR, 10-daily (dekadal) cadence. Requires a (free) account:
  second secrets-using entry, different auth flow than CDS.
- Vegetation stress for drought early warning: anomalies against a
  baseline are a later derived integration; this entry lands the raw
  index.
- NetCDF delivery is likely, exercising the non-GDAL read path in the
  Python runtime.

## Acceptance checks

- Dekadal snapshots at the declared cadence; values in [0, 1] with
  physically sensible nodata handling.
- Dense forest in the AOI reads high (>0.7 in growing season); desert or
  bare ground reads low.
- Credentials referenced by name only.

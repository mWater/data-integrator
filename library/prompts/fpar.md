# FPAR vegetation productivity

## Prompt

> Connect FPAR (fraction of absorbed photosynthetically active radiation)
> from the Copernicus Land Monitoring Service as a 10-daily time-series
> raster layer named "Vegetation productivity (FPAR)", dimensionless 0-1,
> for the deployment's area of interest. Backfill six months and keep it
> current. Copernicus Data Space Ecosystem S3 keys are in the secret named
> cdse_s3_credentials.

## Scope

- CLMS 300 m FPAR, 10-daily (dekadal) cadence. Requires a free Copernicus
  Data Space Ecosystem account with S3 keys (access key, secret key,
  endpoint): second secrets-using entry, different auth flow than the ECMWF
  datastores.
- Vegetation stress for drought early warning: anomalies against a
  baseline are a later derived integration; this entry lands the raw
  index.
- Delivered as COGs on the CDSE eodata S3 bucket, read with range requests
  through GDAL's /vsis3/ so only the AOI window is fetched.

## Acceptance checks

- Dekadal snapshots at the declared cadence; values in [0, 1] with
  physically sensible nodata handling.
- Dense forest in the AOI reads high (>0.7 in growing season); desert or
  bare ground reads low.
- Credentials referenced by name only.

# Observed flood extent (SAR-derived)

## Prompt

> Connect the Copernicus Global Flood Monitoring observed flood extent,
> which is derived from Sentinel-1 SAR, for the deployment's area of
> interest. Store each observation as a snapshot on a time-series raster
> layer named "Observed flood extent" so we can see the history of
> flooding. Check for new observations daily. Credentials are in the
> secret named gfm_credentials.

## Scope

- GFM satisfies the ToR's SAR box with a derived, operationally consumable
  product; ingesting raw Sentinel-1 scenes and running a SAR processing
  chain is out of scope for the PoC and stated as such.
- Event-driven data on a polling schedule: many runs will legitimately
  find nothing new, exercising clean no-op runs.
- Coverage depends on Sentinel-1 revisit; gaps are expected and must not
  flag as failures.

## Acceptance checks

- A known recent flood event in or near the AOI appears as a snapshot with
  a sensible footprint and date.
- Dry-period runs succeed with zero snapshots and say so in the run
  record.
- Binary/classified values documented in the band metadata; nodata
  declared.

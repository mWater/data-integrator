# Observed flood extent (SAR-derived)

## Prompt

> Connect the Copernicus Global Flood Monitoring observed flood extent,
> which is derived from Sentinel-1 SAR, for the deployment's area of
> interest. Store each observation as a snapshot on a time-series raster
> layer named "Observed flood extent" so we can see the history of
> flooding. Check for new observations daily. The catalogue is public; no
> credentials are needed.

## Scope

- GFM covers the architecture's SAR-derived flood source with a derived, operationally consumable
  product; ingesting raw Sentinel-1 scenes and running a SAR processing
  chain is out of scope for this entry and stated as such.
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

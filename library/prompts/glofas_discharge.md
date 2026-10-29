# GloFAS river discharge

## Prompt

> Connect Copernicus GloFAS river discharge for the deployment's area of
> interest as a daily time-series raster layer named "River discharge" in
> m3/s. Use the consolidated/reanalysis product for history and keep it
> current daily. You have an Early Warning Data Store (EWDS) API token in
> the secret named cds_api_token. Backfill the last 90 days.

## Scope

- GloFAS-ERA5 daily discharge via the EWDS API (GloFAS is on the EWDS, not
  the CDS; a CDS token does not work there): first secrets-using entry,
  first GRIB source, and a queued-retrieval API (requests are asynchronous
  on the EWDS side), which stress-tests job timeouts and /work caching.
  The token's account must have accepted the CEMS-FLOODS licence on the
  EWDS.
- Forecast products (30-day, seasonal) are follow-on entries once the
  reanalysis path is proven.
- Discharge is meaningful on the river network, not everywhere: styling
  and the acceptance checks read at river cells.

## Acceptance checks

- Daily snapshots for the backfill window; units m3/s; nodata declared.
- Discharge at a major river cell is positive and seasonally plausible;
  off-river cells are near zero or nodata.
- Secret is referenced by name only; it appears nowhere in the definition,
  code, or logs.

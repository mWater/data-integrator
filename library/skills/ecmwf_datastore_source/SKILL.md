---
name: ECMWF datastore source
description: CDS/ADS/EWDS datastores - which hosts what, PRIVATE-TOKEN auth, async retrieve API flow, product tiers, valid_time labelling
verified: 2026-08-26
---

# ECMWF datastores (CDS, ADS, EWDS)

One ECMWF account, three separate datastores with separate API endpoints;
a token is minted per store and does not work across them:

- **CDS** `cds.climate.copernicus.eu` - ERA5, seasonal forecasts, CMIP.
- **ADS** `ads.atmosphere.copernicus.eu` - CAMS atmosphere/air quality.
- **EWDS** `ewds.climate.copernicus.eu` - CEMS early warning: **GloFAS**
  river discharge, EFAS, fire danger. GloFAS is here, not on the CDS.

The account must have accepted the dataset's licence in the store's web UI
once (e.g. CEMS-FLOODS) or every retrieval fails; say so when a request is
rejected with a licence error.

## API flow (no cdsapi dependency needed)

Auth is a `PRIVATE-TOKEN: <token>` header. Base `<store>/api`:

- `GET  /catalogue/v1/collections/<dataset>` - metadata; follow its
  constraints link for the valid value combinations per field (use it to
  discover which dates each product tier covers, without trial requests).
- `POST /retrieve/v1/processes/<dataset>/execution` with
  `{"inputs": {...request...}}` - returns a `jobID`. **Retrieval is
  asynchronous and queued**: seconds when cached, minutes+ under load.
- `GET  /retrieve/v1/jobs/<id>` - poll status (backoff; bound the wait and
  raise a clear timeout). `GET /retrieve/v1/jobs/<id>/results` - asset
  href to download when successful.

Cache downloads in /work keyed by a digest of the request body: re-runs
and cold certification then skip the queue entirely for already-fetched
groups. Batch days into one request per month/product rather than one job
per day - each job pays the queue toll once.

`area` is `[N, W, S, E]`. NetCDF output is GRIB-derived: values are
packed/quantized (small value steps like 1/32 are normal) and the data
variable keeps GRIB metadata names (e.g. `avg_dis`).

## Product tiers and revision

Reanalysis-derived datasets publish in tiers: **consolidated** (final,
months behind) and **intermediate** (ERA5T-based, days behind). To be both
current and eventually-correct: use consolidated where available, fill the
recent window with intermediate, and re-fetch/replace those dates when
consolidation catches up - track which dates came from which tier in
previousState.

## Time labelling

Time-mean daily fields are labelled at the END of their 24-hour window:
requesting day D yields `valid_time` D+1 00:00. Subtract a day to recover
the represented date; off-by-one here shifts the whole series.

## Verifying values

Model output can be far from gauge climatology in uncalibrated basins
(GloFAS v4 runs low over e.g. Madagascar). To separate ingest bugs from
source bias, pull one small-bbox day directly from the API and diff cells
against the stored raster - fidelity is cell-exact when the pipeline is
clean. Document known bias as a source characteristic in the entry.

---
name: GFM flood extent source
description: Copernicus Global Flood Monitoring - separate account store, REST API timeouts, use the EODC STAC catalogue, frame granularity, daily compositing
verified: 2026-08-28
---

# Copernicus Global Flood Monitoring (GFM)

Sentinel-1 SAR derived observed flood extent, 20 m, binary, global. Three
traps in a row: the account, the API, and the data granularity.

## Accounts: GFM is not the GloFAS viewer

The GFM service has its own account store. Register at
**https://portal.gfm.eodc.eu/** - an account on
global-flood.emergency.copernicus.eu (the GloFAS/flood-viewer site) does NOT
exist for the GFM API, and its login fails with "E-mail address does not
exist". After `POST https://api.gfm.eodc.eu/v2/auth/login` (`{email,
password}`), the response has no user id field: **the returned `client_id`
is the user_id** for every `/aoi/user/{user_id}`-style path (confirmed in
the portal SPA's own code). Endpoint map: `/v2/swagger.json`.

## The REST API stalls; use STAC instead

The authenticated product-listing endpoints time out (60+ s) even for a
one-degree AOI and a two-month window - not certifiable. The same rasters
are published publicly (no credentials) in the EODC STAC catalogue:

- Catalogue: `https://stac.eodc.eu/api/v1/` - collection **GFM**,
  POST `/search` with bbox + datetime.
- Asset `ensemble_flood_extent`: 20 m Equi7 COGs, values **0** = observed
  no flood, **1** = observed flood, **255** = nodata. Decode and declare
  your own nodata.
- The endpoint flaps under load (read timeouts for minutes at a time).
  Bound waits, fail the run cleanly, keep per-run batches small so retries
  are cheap; the cursor makes recovery automatic.

## Frames are not maps: composite per day

Sentinel-1 images a continuous strip sliced into frames ~25-30 s apart, and
GFM publishes flood extent per frame. One pass over a country-sized AOI is
a stack of narrow slices, several passes a day. Stored raw, "the flooding
on date X" is unviewable - each snapshot is one slice.

Composite per UTC day: **1 if any frame saw flood, else 0 if any frame
observed the pixel, else nodata.** Emit uncovered days as explicit
all-nodata snapshots through the same pipeline, so "not observed" and
"observed dry" stay distinguishable. This generalizes to any scene/swath
source (SAR, optical scenes): pick the analysis cadence, composite to it,
and never let per-scene timestamps become the layer's time axis.

The mask is sparse - build max-pooled overviews or floods vanish when
zoomed out (see the sparse raster overviews skill).

## Expectations

- Dry season: near-zero flood pixels is a correct answer, not a failed
  integration. Verify mechanics (frames enumerate, rasters decode, cadence).
- Cyclone season (Madagascar: Dec-Mar) carries the signal - hundreds of
  km2 of flood on landfall days.
- Days without any Sentinel-1 overpass exist (coverage is not daily);
  absence of observation is not absence of flood.

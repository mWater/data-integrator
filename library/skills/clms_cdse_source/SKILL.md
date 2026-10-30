---
name: CLMS via CDSE source
description: Copernicus Land Monitoring Service products - why the CLMS download API stalls, direct CDSE S3 access, FAPAR encoding, RTn revisions
verified: 2026-08-27
---

# CLMS products via the Copernicus Data Space Ecosystem

Copernicus Land Monitoring Service biophysical products (FPAR/FAPAR, NDVI,
LAI, soil moisture and friends). Two access routes exist for the same data;
choose the second.

## Route 1: the CLMS download API (avoid)

`land.copernicus.eu` offers an authenticated "custom download" API:
service-account JSON key (client_id, key_id, RSA private key), OAuth2
JWT-bearer grant against its token_uri, then submit packaging tasks capped
at **31 days each** and poll `@datarequest_search`.

Observed failure mode: the packaging queue **accepts every request and
fulfils none** - tasks sit `In_progress` for 11+ hours with no progress
field, no queue position, no rejection. Nothing distinguishes a busy queue
from a wedged one, which makes this API impossible to certify against.
Auth details (kept for reference): JWT claims `iss` = client_id, `sub` =
user_id, `aud` = token_uri, header `kid` = key_id, RS256, grant type
`urn:ietf:params:oauth:grant-type:jwt-bearer`.

## Route 2: direct CDSE S3 (use this)

The same products live as Cloud-Optimized GeoTIFFs in the CDSE `eodata`
object store, readable with S3 range requests:

- Endpoint `https://eodata.dataspace.copernicus.eu`, bucket `eodata`,
  path-style addressing; credentials are an access/secret keypair from the
  CDSE S3 keys manager (a free Dataspace account).
- Products under `CLMS/bio-geophysical/<product>/...`, e.g.
  `vegetation_properties/fapar_global_300m_10daily_v2`.
- Read with GDAL/rasterio (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
  `AWS_S3_ENDPOINT`, `AWS_VIRTUAL_HOSTING=FALSE`): open the global COG and
  window-read the AOI - only those bytes transfer. No queue, no chunking
  limits, no packaging wait.

## FAPAR v2 (300 m, 10-daily) specifics

- Encoding: `uint8`, physical value = DN x **0.004**, valid DN **0-235**,
  nodata DN **255**. Decode to float32 and declare your own nodata.
- Dekads are nominal-dated (10th, 20th, month-end); the current period
  publishes as **RT0** and is revised as **RT1/RT2...** - select the
  highest RTn per date and revisit a recent overlap so revisions replace
  earlier values.
- Verified deployment reality check (Madagascar): rainforest reads
  0.84-0.94, arid shrubland ~0.15-0.25, ocean nodata.
- License: Copernicus data and information policy (free, full and open
  access; attribution required).

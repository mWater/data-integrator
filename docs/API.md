# API

The programmatic interface to the harmonized dataset: tables, the raster
catalog (including a STAC API), webhooks, integration files, and
integration export/import. Machine-readable contract: `GET /api/openapi.json`
(public, no data). Everything here works with no AI configured.

Examples use `$BASE` for the server origin (e.g. `http://127.0.0.1:8080`) and
`$TOKEN` for a personal access token.

## Authentication

Two interchangeable credentials, both tied to a user and their role:

- Session cookie: `POST /api/login` with `{email, password}` sets the
  `di_session` cookie (what the UI uses). `POST /api/logout` ends it. When the
  account policy has expired the password, sign-in returns 401 with
  `{code: "password_expired"}`; send `newPassword` with the same body to set a
  new password and sign in. A new password shorter than 8 characters or equal
  to the old one returns 400.
- Personal access token: mint with `POST /api/tokens {name, expiresDays?}` (or
  `cli.js user token <email> [name]`), then send `Authorization: Bearer dit_...`.
  The secret is returned once and stored hashed. `GET /api/tokens` lists your
  tokens (id, name, created, last used, expiry; never the secret);
  `DELETE /api/tokens/:id` revokes one.

A bearer token takes precedence over a cookie and carries its user's full
role. Every route below needs one of the two unless it says otherwise.

### Credential lifecycle and abuse protection

- **Issuance.** Each user mints tokens for their own account; an admin can mint
  one for any account from the host (`cli.js user token`). A token is a 256-bit
  random value, shown once and stored only as a SHA-256 hash.
- **Expiry.** Optional per token (`expiresDays`); sessions last 30 days. A
  deployment can also expire passwords and disable idle accounts (Settings,
  Account policy; both off by default).
- **Scope.** A token acts as its owner with the owner's current role; a role
  change applies to existing tokens at once. There are no narrower scopes: give
  an external system its own viewer account.
- **Revocation.** `DELETE /api/tokens/:id`; disabling a user stops all of that
  user's tokens and sessions immediately.
- **Abuse protection.** Ten failed sign-ins lock an account for 15 minutes,
  and unknown and known emails take the same time to reject. Request bodies are
  capped at 1 MB (uploads have their own limit), table reads run read-only with
  a 30 s statement timeout and a 10,000-row cap. Request rate limiting and WAF
  rules belong at the reverse proxy.
- **Logging.** Sign-ins and every write, including token creation and
  revocation, are written to the security event log
  ([Deployment](Deployment.md#security-event-log)).

- `GET /api/me` - `{user: {id, email, role}, ai: {provider, model, ackRequired}}`;
  401 when not signed in.
- `POST /api/me/password {currentPassword, newPassword}` - change your own
  password (at least 8 characters).
- `/api/users` (admin) - list, create (`POST {email, role}`, returns a
  generated password once), and `POST /api/users/:id/password` (reset),
  `PUT /api/users/:id/role {role}`, `PUT /api/users/:id/disabled {disabled}`.
  The last active admin cannot be demoted or disabled.

### Roles

| | viewer | editor | admin |
|---|---|---|---|
| Read tables, layers, tiles, snapshots, STAC; view dashboards | yes | yes | yes |
| Export integrations | yes | yes | yes |
| Explore (plain-language questions) | yes | yes | yes |
| Design, install, run, schedule, pause, rename, import integrations | | yes | yes |
| Upload, download, and run integration files; open design sessions | | yes | yes |
| Read webhook URLs; see credential names | | yes | yes |
| Build, save, restore, rename, delete dashboards | | yes | yes |
| Make a dashboard public or private (opens its data to the internet) | | | yes |
| Set or delete credential values; rotate webhook tokens | | | yes |
| Deployment settings, AI limits, users, other people's Explore chats | | | yes |

## Tabular data

- `GET /api/tables` - queryable tables with their declared schemas
  (`{tableId, integrationId, name, description, columns}`; columns carry
  types, units, and enum codes): the dataset is self-describing.
- `GET /api/tables/:tableId/rows` - filtered read. Parameters:
  - `where`: URL-encoded JSON array (or single object) of
    `{column, op, value}`; ops `= != > >= < <= in` (`in` takes an array).
    Same vocabulary definitions use for inputs.
  - `columns`: comma-separated ids (default all).
  - `order`: `column`, `column.asc`, or `column.desc` (default insertion order).
  - `limit` (default 1000, max 10000), `offset` for paging.
  - `format`: `json` (default, `{columns, rows}`), `csv`, or `geojson` (the
    first selected geometry column becomes the feature geometry; 400 when
    none is selected). Geometry is GeoJSON in WGS84 in every format.

```sh
# Large level-8 catchments from hydrosheds_hydrography, biggest first, as CSV
curl -G -H "Authorization: Bearer $TOKEN" "$BASE/api/tables/hydrobasins/rows" \
  --data-urlencode 'where=[{"column":"upstream_area_sq_km","op":">","value":100000}]' \
  --data-urlencode 'columns=hybas_id,pfaf_id,upstream_area_sq_km,endorheic' \
  --data-urlencode 'order=upstream_area_sq_km.desc' \
  --data-urlencode 'format=csv'
```

For maps of a table:

- `GET /api/tables/:tableId/geometry` - `{geometryColumn, extent}`: the first
  geometry column (null when the table has none) and the data's
  `[west, south, east, north]` (null when empty).
- `GET /api/tables/:tableId/tiles/:z/:x/:y.mvt` - Mapbox Vector Tiles of the
  table, source layer `features`, every column as a property. Built for
  display: geometry is simplified to the tile's resolution and each tile keeps
  at most 2048 features, largest first. Use `/rows` to extract data.

## Raster catalog

- `GET /api/layers` - installed layers: id, name, temporality, bands, the
  current snapshot with its time, CRS, cell size and footprint, and every
  promoted snapshot (`{id, observed_at, observed_end, sources}`, where
  `sources` is the number of files). Also `masked` (tiles are clipped to the
  layer's area by default) and `mask_key` (a short key of that shape).
- `GET /api/layers/:id` - one layer in full (camelCase fields): the above plus
  the owning integration's id, name and description, the source attribution,
  `retentionDays`, and `sizeBytes` stored.
- `GET /api/layers/:id/sample?snapshot=<id>&lon=<lon>&lat=<lat>[&band=<bandId>]` -
  `{value}` of one snapshot at a WGS84 point (default first band); null for
  nodata or outside the data.
- `GET /api/snapshots/:id/download[?source=<ordinal>]` - one Cloud-Optimized
  GeoTIFF of a snapshot. A snapshot can hold several files (e.g. tiles of a
  large area); `source` picks one by 0-based ordinal (default 0), and the
  file name gains a `_<ordinal>` suffix when there are several. 404 for an
  empty snapshot or an ordinal past the end.
- `GET /tiles/:layerId/:snapshotId[/:bandId]/:z/:x/:y.png` - rendered XYZ map
  tiles in Web Mercator, snapshot-pinned and cached as immutable. Omit the
  band segment for the layer's first band. Drawing is clipped to the layer's
  mask: the owning integration's area of interest as a shape (the inherited
  deployment default, or the integration's own countries); an explicit box or
  a full-extent integration has no mask. `?mask=0` draws everything the files
  cover. Put the layer's `mask_key` in the URL as `?m=<key>`: the server
  ignores it, but it changes the URL when the area is reshaped, so browsers
  and proxies do not serve a stale clip. Stored rasters are never cut.

### STAC

A read-only [STAC](https://stacspec.org) 1.0.0 API over the same catalog: one
Collection per installed raster layer, one Item per promoted snapshot, its
COG files as assets. Authentication is the same as every other route (bearer
token or cookie), and asset links point at `/api/snapshots/:id/download`, so
downloading them needs the same credential. Links are absolute, built from
the `Host` (or `X-Forwarded-Host` and `X-Forwarded-Proto`) the client used.

- `GET /api/stac` - landing Catalog with `conformsTo` (STAC core,
  collections, ogcapi-features; OGC API Features core and GeoJSON) and a
  `child` link per collection. Title is the deployment's site title.
- `GET /api/stac/conformance` - `{conformsTo}`.
- `GET /api/stac/collections` - every Collection: title and description,
  license (SPDX id, else `other`), providers, spatial and temporal extent of
  the promoted snapshots, and `summaries.bands` (name, description, unit,
  nodata).
- `GET /api/stac/collections/:layerId` - one Collection.
- `GET /api/stac/collections/:layerId/items` - Items, newest first, as a
  GeoJSON FeatureCollection with `numberReturned`. Parameters:
  - `limit`: page size, default 100, at most 1000 (larger values are
    lowered).
  - `datetime`: an RFC 3339 instant, or an interval `start/end` with `..` for
    an open bound. Matches snapshots whose observation period overlaps it.
  - `bbox`: `west,south,east,north` in WGS84; matches footprints that
    intersect it.
  - `token`: paging cursor. Follow the `next` link, present while more items
    remain; it carries the other parameters.
- `GET /api/stac/collections/:layerId/items/:snapshotId` - one Item.

Items carry `datetime` (or `start_datetime`/`end_datetime` for a period),
`created`, the footprint as geometry and bbox, and assets `data` (one file)
or `data-0`, `data-1`, ... (several). `?lang=<code>` picks the locale of
collection titles and descriptions (default `en`). Errors are
`{code, description}`: 400 `InvalidParameterValue`, 404 `NotFound`.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stac/collections/spi3/items?datetime=2025-01-01T00:00:00Z/..&bbox=33.9,-4.7,41.9,5.0&limit=12"
```

```python
import os, requests
from pystac_client import Client

base, token = os.environ["BASE"], os.environ["TOKEN"]
headers = {"Authorization": f"Bearer {token}"}
catalog = Client.open(f"{base}/api/stac", headers=headers)
for item in catalog.get_collection("spi3").get_items():
    href = item.assets["data"].href
    with open(f"{item.id}.tif", "wb") as f:
        f.write(requests.get(href, headers=headers).content)
```

There is no cross-collection `/search` endpoint; query each collection's
items.

## Integrations

- `GET /api/integrations` - installed integrations with last-run status.
- `GET /api/integrations/:id` - detail: current definition and version,
  enabled and status, the 50 most recent runs (status, times, stats, error,
  and `flags`: data-quality findings from the definition's validation rules,
  null when none), and per-destination stored-data counts.
- `POST /api/integrations/:id/run` - manual run (editor/admin). Optional
  body `{files: {slotId: versionId}}` pins file versions (a revert, or one run
  over several replaced files); a pinned run starts at once when the
  integration is idle, otherwise it queues, joining an already-queued run.
  Body `{rebuild: true}` starts a rebuild instead: a run with no previous
  state and an empty `/work`, which produces everything in scope again (it
  takes no pins). Returns `202 {runId, status}`. An unpinned run is refused
  with 400 while a declared file slot awaits its first upload, and with 409
  while a run is queued or running or the integration is a draft.
- `GET /api/integrations/:id/versions` - definition history, newest first:
  version, when, installing user, and each version's area of interest.
- `PUT /api/integrations/:id/aoi` - change the area of interest (editor/admin).
  Body `{mode: "inherit"}` (deployment default), `{mode: "full"}` (source's
  full extent), or `{mode: "box", aoi: {bbox, countries?}}`. Archives a new
  attributed definition version.
- `PUT /api/integrations/:id/settings` - set the deployment's values for the
  definition's declared settings (editor/admin). Body `{values: {settingId:
  value | null}}`; null restores the default. Values are checked against each
  setting's type, bounds, choices and pattern (400 otherwise). Archives a new
  attributed definition version.
- `PUT /api/integrations/:id/trigger` - replace the schedule (editor/admin).
  Body `{cron?: string|null, webhook?: boolean, webhookDelaySeconds?: number}`;
  omitted fields are cleared. Cron is standard 5-field, UTC, validated; the
  delay (integer 0-86400, webhook only) batches events into one run per
  window. Also a versioned definition edit. Returns `{version, trigger}`.
- `PUT /api/integrations/:id/enabled` - `{enabled: boolean}` (editor/admin).
  Pauses/resumes scheduling; operational state, not versioned.
- `GET /api/integrations/:id/export` - the current definition as a
  downloadable `<id>.integration.json`. A concrete area of interest is
  stripped (it belongs to this deployment, so the importer's default applies);
  an explicit `aoi: null` (full extent) is kept, since it is a property of the
  source.
- `POST /api/integrations/import` - install an exported definition
  (editor/admin). Body is the definition JSON (`id`, `runtime`, and `code`
  required). Validates it, answers 409 when the id is installed and 400 on
  validation errors or a destination another integration owns, and installs
  it paused (`{id, version, enabled: false}`) so the operator can review the
  code and run it manually before enabling the schedule.

## Integration files

Uploaded files an integration reads at `/in/files/<slot><ext>`; see
[Integration Files](Integration%20Files.md).

- `PUT /api/integrations/:id/files/:slot?filename=<name>&run=true|false` -
  upload a new version as the raw request body (editor/admin; not multipart).
  Every check runs before the body is read, and `Expect: 100-continue` is
  answered only once they pass. `run=true` (the default) needs an installed,
  non-draft integration that declares the slot and accepts the extension, and
  starts or queues a run pinning the version; `run=false` only stores it.
  Bodies past `FILE_UPLOAD_MAX_MB` (default 100) get 413; a full disk gets
  507. Returns `201 {version, run, runError?}`; the version is kept even when
  the run could not start (`runError`).

  ```sh
  curl -T inventory.xlsx -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/integrations/water_points/files/inventory?filename=inventory.xlsx"
  ```
- `GET /api/integrations/:id/files` - `{slots, maxUploadMb}`: each slot with
  its versions (size, SHA-256, upload time, current, purged, and the runs that
  read it) and bytes stored. Filenames and uploader emails are null for
  viewers.
- `GET /api/integrations/:id/files/:slot/versions/:versionId/download` - one
  version as an inert attachment (editor/admin); 410 once purged.

Every version is kept. An admin purges one uploaded by mistake with
`cli.js files purge <versionId> --by <adminEmail>`.

## Webhooks

- `POST /hooks/:token` - public webhook receiver. The random per-integration
  token in the URL is the credential; no session or bearer token applies.
  `Content-Type: application/json` only (415 otherwise), 1 MB cap (413).
  Each request body is stored verbatim as one opaque event; the next run
  receives every pending event oldest-first in `ctx.webhookData`
  (`ctx.webhook_data` in Python), and events count as consumed only when
  that run commits, so a failed run leaves them for the next. A receipt
  enqueues a run: immediately by default, or at the end of a batch window
  when the trigger sets `webhookDelaySeconds` (the first event anchors the
  window and later events join its run; suits high-frequency sensor feeds). Events for a paused or draft integration, or
  one with an empty file slot, buffer until it runs again. Returns
  `202 {eventId}`. Unknown tokens and integrations whose trigger does not
  accept webhooks 404 alike.
- `GET /api/integrations/:id/webhook-token` - `{token, path}` (editor/admin).
- `POST /api/integrations/:id/webhook-token` - rotate the token (admin);
  returns the new `{token, path}`. The old URL stops working immediately.

A reading for the `insitu_sensor_webhook` library entry:

```sh
curl -X POST -H "Content-Type: application/json" \
  -d '{"station_id":"KE-001","variable":"water_level","timestamp":"2026-03-01T06:00:00Z","value":1.42,"unit":"m"}' \
  "$BASE/hooks/$WEBHOOK_TOKEN"
```

## Library

- `GET /api/library` - the deployment's integration library with per-entry
  status: `not_installed`, `installed`, or `update_available` (compared
  ignoring the deployment-owned fields aoi/trigger/limits/settingValues).
- `POST /api/library/:id/install` - install or update (editor/admin). Updates
  keep the installed aoi, trigger, limits, and the setting values the new
  definition still accepts. Body `{runNow?: boolean}`
  starts the first ingest when a job runner is configured. Returns
  `{version, runId}`.

## Deployment settings

- `GET /api/countries` - baked-in country bounding boxes (Natural Earth
  derived, `{iso3, name, bbox}`) powering AOI pickers, offline.
- `GET /api/settings` - any signed-in user: `{settings: {default_aoi,
  site_title, locales}, supportedLocales, catalogTranslation}`. `default_aoi`
  is the area integrations without one of their own inherit at run time.
- `PUT /api/settings/default_aoi` (admin) - body `{bbox, countries?, name?}`.
  `DELETE` clears it. Saving also rebuilds the area's shape: with country
  codes, the countries' land outlines (Natural Earth 1:10m, lakes removed)
  cut to the box; without, the box itself. The shape is the `aoi` row of the
  SQL surface, and `aoi_stats(layer_id, at, threshold, op, band)` returns
  area-weighted statistics of a raster layer over it (mean, share meeting
  the condition, coverage, cell size, method, snapshot used, boundary
  provenance). Coarse pixels are weighted by the part inside the boundary,
  fine ones by their area at their latitude; nodata is excluded.
  Integrations still fetch by the box: it is a download window, and the
  shape is what "of the country" statistics clip to.
- `PUT /api/settings/site_title` (admin) - `{title}` (at most 120
  characters; empty or null restores the default).
- `PUT /api/settings/locales` (admin) - `{locales: [code, ...]}` from
  `supportedLocales`. Adding a language starts a background translation of
  catalog text when AI is configured; poll `GET /api/settings` for
  `catalogTranslation`.
- `GET /api/settings/ai_limits` (admin) - `{limits: {userDailyTokens,
  deploymentDailyTokens}, usedToday}`: daily AI token caps (input plus output
  tokens, per UTC day; default 5,000,000 per user and 25,000,000 per
  deployment) and the deployment's usage so far today.
- `PUT /api/settings/ai_limits` (admin) - `{userDailyTokens,
  deploymentDailyTokens}`, each a positive integer or null for no cap (an
  omitted field counts as null). Returns the same shape as GET.
- `GET /api/settings/account_policy` (admin) - `{policy: {passwordMaxAgeDays,
  inactiveDisableDays}}`: optional password expiry (checked at sign-in) and
  disabling of accounts with no sign-in or API use for that many days (daily
  sweep). Both null (off) by default.
- `PUT /api/settings/account_policy` (admin) - `{passwordMaxAgeDays,
  inactiveDisableDays}`, each a whole number of days from 1 to 3650 or null to
  turn the rule off (an omitted field counts as null). Returns the same shape
  as GET.

## Limits

Table reads run in read-only transactions with a 30 s statement timeout and a
10,000-row cap per request; page with `limit`/`offset`. Filters and
identifiers are validated against the table schema before any SQL is built.
JSON request bodies are capped at 1 MB.

## Other routes

The remaining routes serve the web UI. They can change between releases
without notice and are not documented here:

- Landing page and catalog: `/api/home`, `/api/sources`, `/api/skills`,
  `/api/library/:id`.
- Integration management: rename (`PUT /api/integrations/:id/name`), delete,
  usage, destination previews (`/api/integrations/:id/tables/:table/rows`),
  and credentials (`/api/secrets`, `/api/integrations/:id/secrets[/:name]`).
- AI: provider settings (`/api/settings/ai`), catalog translation
  (`/api/settings/translate-catalog`), the data-processing acknowledgement
  (`/api/me/ai-acknowledge`), and agent sessions (`/api/sessions/...`:
  designer, dashboard builder, Explore).
- Dashboards: `/api/dashboards/...` (list, save, version history and restore,
  rename, publish, and the view surface public dashboards use without a session).
- Static assets: `/basemap/...` (basemap proxy), `/kit/...` (dashboard
  runtime), and the single-page app.

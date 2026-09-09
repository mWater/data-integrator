# API

The documented query interface over the harmonized dataset. Machine-readable
contract: `GET /api/openapi.json`. Works fully with no AI configured.

## Authentication

Two interchangeable credentials, both tied to a user and their role:

- Session cookie: `POST /api/login` with `{email, password}` (what the UI uses).
- Personal access token: mint with `POST /api/tokens {name, expiresDays?}` (or
  `cli.js user token <email> [name]`), then send `Authorization: Bearer dit_...`.
  The secret is shown once and stored hashed. List with `GET /api/tokens`,
  revoke with `DELETE /api/tokens/:id`.

### Roles

| | viewer | editor | admin |
|---|---|---|---|
| Read tables, layers, tiles, snapshots; view dashboards | yes | yes | yes |
| Explore (plain-language questions) | yes | yes | yes |
| Design, install, run, schedule, pause, rename, import integrations | | yes | yes |
| See credential names | | yes | yes |
| Build, save, rename, delete dashboards | | yes | yes |
| Make a dashboard public or private (opens its data to the internet) | | | yes |
| Set or delete credential values; rotate webhook tokens | | | yes |
| Deployment settings, users, other people's Explore chats | | | yes |

Making a dashboard public is recorded: while public, the dashboard carries
the admin who did it and when (`PUT /api/dashboards/:id/public {public}`).

## Tabular data

- `GET /api/tables` - queryable tables with their declared column schemas
  (types, units, enum codes): the dataset is self-describing.
- `GET /api/tables/:tableId/rows` - filtered read. Parameters:
  - `where`: URL-encoded JSON array of `{column, op, value}`; ops
    `= != > >= < <= in`. Same vocabulary definitions use for inputs.
  - `columns`: comma-separated ids. `order`: `column` or `column.desc`.
  - `limit` (default 1000, max 10000), `offset` for paging.
  - `format`: `json` (default), `csv`, or `geojson` (first geometry column
    becomes the feature geometry).

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/tables/rainfall_stats/rows?where=%5B%7B%22column%22%3A%22mean_mm%22%2C%22op%22%3A%22%3E%22%2C%22value%22%3A100%7D%5D&order=month.desc&format=csv"
```

## Raster catalog

- `GET /api/layers` - layers, band metadata, and promoted snapshots, with
  `masked` (tiles are clipped to the layer's area by default) and `mask_key`
  (a short key of that shape).
- `GET /api/snapshots/:id/download` - the snapshot's COG.
- `GET /tiles/:layerId/:snapshotId[/:bandId]/:z/:x/:y.png` - rendered map
  tiles, snapshot-pinned and immutable. Drawing is clipped to the layer's
  mask: the owning integration's area of interest as a shape (the inherited
  deployment default, or the integration's own countries); an explicit box
  or full-extent integration has no mask. `?mask=0` draws everything the
  files cover. Put the layer's `mask_key` in the URL (`?m=...`) so a reshaped
  area is not served from cache. Stored rasters are never cut.

## Integrations

- `GET /api/integrations` - installed integrations with last-run status.
- `GET /api/integrations/:id` - detail: current definition and version, recent
  runs, per-destination stored-data stats.
- `POST /api/integrations/:id/run` - manual run (editor/admin).
- `GET /api/integrations/:id/versions` - definition history, newest first:
  version, when, installing user, and each version's area of interest.
- `PUT /api/integrations/:id/aoi` - change the area of interest (editor/admin).
  Body `{mode: "inherit"}` (deployment default), `{mode: "full"}` (source's
  full extent), or `{mode: "box", aoi: {bbox, countries?}}`. Archives a new
  attributed definition version; an unchanged state is a no-op.
- `PUT /api/integrations/:id/trigger` - change the schedule (editor/admin).
  Body `{cron?: string|null, webhook?: boolean, webhookDelaySeconds?: number}`;
  cron is standard 5-field, UTC, validated; the delay (0-86400, webhook only)
  batches events into one run per window. Also a versioned definition edit.
- `PUT /api/integrations/:id/enabled` - `{enabled: boolean}` (editor/admin).
  Pauses/resumes scheduling; operational state, not versioned.
- `GET /api/integrations/:id/export` - the current definition as a
  downloadable JSON file, with the deployment-owned AOI stripped so the
  importing deployment's default applies.
- `POST /api/integrations/import` - install an exported definition
  (editor/admin). Validates, rejects id and destination collisions, and
  installs paused so the operator can review and run manually before
  enabling the schedule.

## Webhooks

- `POST /hooks/:token` - public webhook receiver. The random per-integration
  token in the URL is the credential; no session or bearer token applies.
  JSON bodies only (1 MB cap); the payload is buffered verbatim and the next
  run receives every pending event oldest-first in `ctx.webhookData`. A
  receipt enqueues a run: immediately by default, or at the end of a batch
  window when the trigger sets `webhookDelaySeconds` (the first event anchors
  the window and later events join its run - suits high-frequency sensor
  feeds). Events for a paused or draft integration buffer until it runs
  again.
  Returns `202 {eventId}`. Unknown tokens and integrations whose trigger
  does not accept webhooks 404 alike.
- `GET /api/integrations/:id/webhook-token` - the token and `/hooks` path
  (editor/admin).
- `POST /api/integrations/:id/webhook-token` - rotate the token (admin).
  The old URL stops working immediately.

## Library

- `GET /api/library` - the deployment's integration library with per-entry
  status: `not_installed`, `installed`, or `update_available` (compared
  ignoring the deployment-owned fields aoi/trigger/limits).
- `POST /api/library/:id/install` - install or update (editor/admin). Updates
  keep the installed aoi, trigger, and limits. Body `{runNow?: boolean}`
  starts the first ingest when a job runner is configured. Returns
  `{version, runId}`.

## Deployment settings

- `GET /api/countries` - baked-in country bounding boxes (Natural Earth
  derived, `{iso3, name, bbox}`) powering AOI pickers, offline.
- `GET /api/settings` - deployment settings: `default_aoi` (the area that
  integrations without one of their own inherit at run time), `site_title`,
  and `locales`.
- `PUT /api/settings/default_aoi` (admin) - body `{bbox, countries?, name?}`.
  `DELETE` clears it. Saving also rebuilds the area's shape: with country
  codes, the countries' land outlines (Natural Earth 1:10m, lakes removed)
  cut to the box; without, the box itself. The shape is the `aoi` row of the
  SQL surface, and `aoi_stats(layer_id, at, threshold, op, band)` returns
  area-weighted statistics of a raster layer over it (mean, share meeting
  the condition, coverage, cell size, method, snapshot used, boundary
  provenance). Coarse pixels are weighted by the part inside the boundary,
  fine ones by their area at their latitude; nodata is excluded. Integrations still fetch by the box: it is a download
  window, and the shape is what "of the country" statistics clip to.

## Limits

Reads run in read-only transactions with a 30 s statement timeout and a
10,000-row cap per request; page with `limit`/`offset`. Filters and identifiers
are validated against the table schema before any SQL is built.

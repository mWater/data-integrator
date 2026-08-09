# API

The documented query interface over the harmonized dataset. Machine-readable
contract: `GET /api/openapi.json`. Works fully with no AI configured.

## Authentication

Two interchangeable credentials, both tied to a user and their role
(admin/editor/viewer; data reads need any role, runs and design sessions need
editor or admin):

- Session cookie: `POST /api/login` with `{email, password}` (what the UI uses).
- Personal access token: mint with `POST /api/tokens {name, expiresDays?}` (or
  `cli.js user token <email> [name]`), then send `Authorization: Bearer dit_...`.
  The secret is shown once and stored hashed. List with `GET /api/tokens`,
  revoke with `DELETE /api/tokens/:id`.

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

- `GET /api/layers` - layers, band metadata, and promoted snapshots.
- `GET /api/snapshots/:id/download` - the snapshot's COG.
- `GET /tiles/:layerId/:snapshotId/:z/:x/:y.png` - rendered map tiles,
  snapshot-pinned and immutable.

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
  Body `{cron?: string|null, webhook?: boolean}`; cron is standard 5-field,
  UTC, validated. Also a versioned definition edit.
- `PUT /api/integrations/:id/enabled` - `{enabled: boolean}` (editor/admin).
  Pauses/resumes scheduling; operational state, not versioned.

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
- `GET /api/settings` - deployment settings; today `default_aoi`, the AOI
  that integrations without one of their own inherit at run time.
- `PUT /api/settings/default_aoi` (admin) - body `{bbox, countries?, name?}`.
  `DELETE` clears it.

## Limits

Reads run in read-only transactions with a 30 s statement timeout and a
10,000-row cap per request; page with `limit`/`offset`. Filters and identifiers
are validated against the table schema before any SQL is built.

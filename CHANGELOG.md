# Changelog

Releases follow [semantic versioning](https://semver.org). Each entry is also
the release's notes on the repository's Releases page, and says when a release
changes the database (applied by `deploy/update.sh`) or the runtime images
(rebuilt with `IMAGES=1`).

## 1.1.0 (2026-11-25)

Corrections and additions made in response to UNICEF's review of release
1.0.0. **Database changes:** two migrations and one superuser setting, all
applied by `deploy/update.sh`. The runtime images are unchanged.

- Deployment guide: "Controls for webhook senders" shows how to restrict
  who may send webhooks at the reverse proxy, by source address and by
  client certificate (mutual TLS), with Caddy configuration for both, and
  says where rate limiting belongs. Documentation only.
- Deployment guide: "Deployment profiles" describes three layouts (a single
  host, a separate database host, several application hosts behind a load
  balancer), what moves a deployment from one to the next, and what each
  needs. Only the single host is installed by the scripts and exercised by
  the proof of concept. "Reference profile and scaling" is corrected in two
  places: a host runs one server process, and the database server must be
  able to read the raster store, so a managed PostgreSQL service that cannot
  mount a filesystem does not fit. Documentation only.
- Basic performance tests: `pnpm perf` times tabular and raster loads, the
  query API, vector and raster map tiles, zonal statistics in SQL and sandbox
  job start-up against a fixed synthetic dataset. It runs in CI on every
  change, publishes its timings in the job summary, and fails only on a
  gross regression. See "Performance tests" in `docs/Architecture.md`.
- GDAL opens files as GeoTIFF only. PostGIS was configured with every GDAL
  driver enabled, and the server let GDAL detect the format of raster files
  written by integration code, so a file named `.tif` could be a VRT that
  points at another file or a URL. Now PostGIS has only the GeoTIFF driver
  enabled, and raster and table files from a run are opened in their declared
  format, so anything else is refused. **Database change:** the setting
  `postgis.gdal_enabled_drivers` becomes `GTiff`; it is a superuser setting,
  so `deploy/update.sh` applies it. Dashboard SQL that calls `ST_AsPNG`,
  `ST_AsJPEG` or `ST_AsGDALRaster` for another format stops working; raster
  statistics, clipping, resampling and map algebra are unaffected.
- The server now rejects a definition that lacks `trigger`, `code` or
  `destinations`, which the definition format has always required. Before, a
  definition without `trigger` was accepted and run by hand only. **Database
  change:** a migration gives stored definitions that lack `trigger` an
  empty one (`{}`, which means the same thing), so integrations already
  installed are unaffected.
- The integration definition format is published as a JSON Schema (draft
  2020-12), `docs/spec/integration-definition.schema.json`, so a library
  publisher or another implementation can check a definition with any
  standard validator, without running this platform. The specification lists
  the rules a schema cannot express (section 2.14), and says how a deployment
  uses a library published by another party (section 1.1). The Deployment
  guide has the steps ("Using another integration library"). No change to
  how the platform validates or runs definitions.
- Webhook senders can send the token in a header instead of the URL:
  `POST /hooks/<integration id>` with `Authorization: Bearer <token>` (or
  `X-Webhook-Token`). This keeps the token out of URLs and proxy logs.
  `POST /hooks/<token>` works as before, for senders that can only post to a
  fixed address. The integration page shows both.
- Removed the `mwater_admin_regions` library entry and its skill, which
  downloaded administrative boundaries from data.mwater.co, an mWater-hosted
  service. The library now has no dependency on an mWater service. A
  deployment that already installed the entry keeps its integration and data
  until an admin deletes it.
- New library entry `geoboundaries_admin_boundaries`: administrative
  boundaries from the open release of geoBoundaries, for the countries of the
  area of interest or the whole world. Every boundary carries its own source
  and license. It writes new tables (`admin_boundaries`,
  `admin_boundary_levels`) with geoBoundaries' ids and no parent ids, so it is
  not a drop-in replacement for `mwater_admin_regions`.
- Changing a password ends the user's other sessions. This covers a user's own
  change (the session making it stays signed in), an admin reset, renewal of an
  expired password at sign-in, and `cli.js user passwd`. Personal access tokens
  are separate credentials and are not revoked.
- Copyright is held by UNICEF: `NOTICE` and the README name the United Nations
  Children's Fund as copyright holder and state that all code was written for
  this project, with none taken from mWater's private codebase.
- `ez-localize` updated to 2.16.0, which is licensed Apache 2.0 (earlier
  versions were LGPL-3.0). No production dependency is now under the GPL or
  LGPL.
- `deploy/health.sh` now exits 1 for every problem it prints. Before, only low
  memory and a failing integration reached the exit status: a stopped
  service, an unreachable database, a disabled scheduler, missing swap, a
  disk at 85% or more and a stale run heartbeat were shown in red but the
  script still exited 0, so a cron job watching the exit status missed them.
  A host that has one of these conditions will start to alert. The scheduler
  check no longer reports "unknown" on a long-running service whose
  start-up log line has rotated out of the journal: it then looks for runs
  the scheduler has started since the service started.

## 1.0.0 (2026-10-30)

First public release of the mWater Data Integrator, the reference
implementation of the open-source Data Integrator architecture developed for
the UNICEF WASH Innovation Hub.

**Platform**

- Integrations: a definition plus one sandboxed code file per data source, run
  by cron, webhook, upload or hand; installed from the bundled library,
  imported from another deployment, or designed with the AI designer.
- Integration settings: options a definition declares (history depth, product
  variant, release pin) that operators change on the integration page as
  versioned edits; Rebuild from Source re-runs an integration from nothing.
- Library: WorldPop, GHS population and built surface, Copernicus DEM,
  HydroSHEDS, GloFAS river discharge, SPI-3 and drought indices, fAPAR, flood
  extent, administrative regions and an in-situ sensor webhook.
- Harmonized storage: typed tables in PostgreSQL/PostGIS and immutable Cloud
  Optimized GeoTIFF snapshots registered for SQL; validation flags, freshness
  monitoring, per-run lineage and per-snapshot source metadata.
- Access: REST API with an OpenAPI description, STAC catalog, map tiles,
  agent-designed dashboards (optionally public, with version history and
  restore) and Explore.
- AI: optional and swappable (OpenRouter, Anthropic, or any OpenAI-compatible
  endpoint including a self-hosted model), with a per-user data notice and
  daily token caps.

**Security**

- Local accounts with admin, editor and viewer roles, scrypt hashing and
  sign-in lockout; personal access tokens with optional expiry.
- Optional account policy: password expiry and disabling of inactive accounts,
  both off by default.
- Security event log: JSON lines on the service log for sign-in outcomes,
  every API write with its actor and outcome, accounts disabled for
  inactivity, and run outcomes.
- Sandbox: rootless podman with gVisor, read-only root filesystem, no
  capabilities, resource limits, and public-internet-only egress.
- Integration credentials and the AI key encrypted at rest with AES-256-GCM.

**Operations**

- `deploy/` scripts for install, configuration, updates, hardening and health
  reports on Ubuntu 24.04; backup and restore procedure in
  [docs/Deployment.md](docs/Deployment.md).
- Interface in English, French, Portuguese, Spanish, Malagasy and Kiswahili.
- Integration runner and runtime images 0.3.0.

**Database and images**

The schema is `0001_app_schema.sql`, `0002_account_policy.sql` and
`0003_dashboard_version_authors.sql`, applied by `deploy/setup.sh` on install.
The runtime images are built by `setup.sh` from `runtimes/` at runner version
0.3.0.

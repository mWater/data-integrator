# Changelog

Releases follow [semantic versioning](https://semver.org). Each entry is also
the release's notes on the repository's Releases page, and says when a release
changes the database (applied by `deploy/update.sh`) or the runtime images
(rebuilt with `IMAGES=1`).

## Unreleased

- Removed the `mwater_admin_regions` library entry and its skill. It
  downloaded administrative boundaries from data.mwater.co, an mWater-hosted
  service, and the dataset is derived from GADM, whose license allows neither
  commercial use nor redistribution. The library now has no dependency on an
  mWater service. A deployment that already installed the entry keeps its
  integration and data until an admin deletes it.
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

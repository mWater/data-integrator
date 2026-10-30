# Changelog

Releases follow [semantic versioning](https://semver.org). Each entry is also
the release's notes on the repository's Releases page, and says when a release
changes the database (applied by `deploy/update.sh`) or the runtime images
(rebuilt with `IMAGES=1`).

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

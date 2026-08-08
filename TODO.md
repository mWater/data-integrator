# Remaining work

Tracked at the level of what is left, not what exists; see README status and the
*(built)* markers for the current state. Rough dependency order within sections.

## Pipeline engine (completes FUC-1/3/4)

- Scheduler loop: cron tick over `trigger.cron`, periodic `reapStaleRuns`, and a
  worker draining the queue (claim/execute already built).
- Webhook receiver endpoint writing `webhook_events` (consumption at run time is
  built and tested; nothing receives events yet).
- Skip-if-unchanged for derived integrations (compare input snapshot ids against
  the previous run's recorded lineage).
- Backfill after connectivity gaps (library entries already do this via
  previousState; verify semantics and document the pattern).
- Validation rules: `validation` in definitions is typed but evaluated nowhere.
  Evaluate on run results, record flags on the run, surface in UI (FUC-3).
- Retention/cleanup job: runs, webhook_events, expired auth_sessions, tile
  cache; orphan GC for raster store files whose commit never landed; scratch
  areas of abandoned design sessions (cleanupScratch on stale non-finished
  sessions).
- /work disk quota enforcement per integration.

## Designer agent

- Hard abort for Stop: kill the in-flight sandbox job and model call (stop
  currently lands at the next step boundary, so a long run finishes first).
- Token-budget compaction with structured summaries (design in Agent Harness.md).
- Cost governance: per-session and per-user daily caps, global kill switch,
  configured by the deployer.
- Live-test the agent designing a derived integration (inputs vocabulary is in
  the prompt, untested end to end with a real model).

## Access layer

- AI query assistant (FUC-5): plain-language queries answered through the
  query API, same swappable provider as the designer. The API and OpenAPI
  contract it needs are built.
- Analytical dashboards: core built per Dashboards.md (kit v0, in-server build,
  sql_engine execution, viewer + side-by-side design session UI, dashboard
  agent). Remaining: live-fire the agent with a real model, library
  distribution of dashboards, headless render test for the install path,
  MapView exercised against a real raster layer, ThemeTokens branding.
- STAC-compatible representation of the raster catalog.
- UI odds and ends: token management page, admin user management page, remove
  the redundant static /map page, code-split the maplibre chunk.
- Accessibility pass over the UI (promised in the ToR).
- OIDC as an optional bolt-on for ministries with identity providers.

## Integration library

- Remaining ToR sources: GloFAS, SPI, FPAR, DEM/FABDEM, GHSL, HydroSHEDS, SAR,
  in-situ sensors, UNICEF datasources.
- Skills directory (`library/skills/`): reusable source and technique know-how
  the agent loads on demand.
- Angola pilot configuration (Madagascar is exercised; Angola AOI/overrides).

## Deployment and compliance (OS-1..9, deliverable 5)

- GitHub remote + CI verified green (workflow exists, never run).
- SPDX/SBOM dependency checks in CI, security policy, exceptions register.
- Clean-room deployment guide (podman/gVisor install, migrate, users, systemd),
  configuration manual, admin/user guides, knowledge-transfer materials.
- TLS guidance and reverse-proxy reference config (cookie Secure flag already
  keys off X-Forwarded-Proto).

## mWater migration (post-OSS)

See mWater Migration.md: v1 compat wrapper, executeScript on the runner,
delete isolated-vm.

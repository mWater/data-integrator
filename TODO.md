# Remaining work

Tracked at the level of what is left, not what exists; see README status and the
*(built)* markers for the current state. Rough dependency order within sections.

## Pipeline engine (completes FUC-1/3/4)

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
- Metadata-only definition edits (band nodata, rendering) still pay a full
  cold re-ingest for certification; scope certification to what changed.

## Designer agent

- Hard abort for Stop: kill the in-flight sandbox job and model call (stop
  currently lands at the next step boundary, so a long run finishes first).
- Token-budget compaction with structured summaries (design in Agent Harness.md).
- Cost governance: per-session and per-user daily caps, global kill switch,
  configured by the deployer.
- Live-test the agent designing a derived integration (inputs vocabulary is in
  the prompt, untested end to end with a real model).

## Access layer

- AI query assistant (FUC-5) is built: assistant sessions over the query API on
  the same swappable provider as the designer, open to viewers, degrades to
  absent when no model is configured. Nothing outstanding beyond the CHIRPS
  nodata entry below, which its raster answers surfaced.
- Analytical dashboards: core built per Dashboards.md (kit v0, in-server build,
  sql_engine execution, viewer + side-by-side design session UI, dashboard
  agent, live-fired). MapView has a proxied OpenFreeMap basemap + GeoJSON
  overlays, verified in-browser both modes. Remaining: library distribution of
  dashboards, headless render test for the install path, MapView against a real
  raster catalog layer, ThemeTokens branding, content-hashed kit asset names
  (immutable cache makes dev reloads stale; today KIT_VERSION is bumped by
  hand).
- STAC-compatible representation of the raster catalog.
- UI odds and ends: token management page.
- No automated tests for `apps/ui` at all (~6k lines of React); every suite in
  the repo is server, runner, or runtime. At minimum, smoke coverage of the
  routes and the API client.
- Localization stops at the UI catalog: server-generated text and agent replies
  are English only. Both are operator-facing in Angola (pt) and Madagascar
  (fr/mg), so decide whether they are in scope before the pilots.
- Accessibility pass over the UI (promised in the ToR).
- OIDC as an optional bolt-on for ministries with identity providers.

## Integration library

- CHIRPS nodata: the library entry now tags NODATA on its COGs and declares
  -9999 on the band, but snapshots promoted before the fix still lack it -
  deployments must install the update and re-promote (re-run) for SQL
  statistics to stop counting sentinels. The agent prompt teaches the interim
  workaround.
- Remaining ToR sources: standardized design-session prompts, scoping
  decisions, and acceptance checks are in `library/prompts/` (GHSL, DEM
  GLO-30, HydroSHEDS, SPI, GloFAS, FPAR, GFM flood extent, in-situ
  webhook). Run them in the README's sequence, logging RESULTS.md; each
  doubles as a live-fire validation of the designer agent. FABDEM parked
  on its non-commercial license; UNICEF datasources parked on the
  Deliverable 2 consultations.
- More skills (`library/skills/` is built: index in the designer prompt,
  read_skill on demand): per-source know-how for the remaining ToR sources
  as they are researched, whether or not a finished entry ships.
- Angola pilot configuration (Madagascar is exercised; for Angola, set the
  deployment default AOI in Settings and install the relevant entries).

## Deployment and compliance (OS-1..9, deliverable 5)

- SPDX/SBOM dependency checks in CI, and the exceptions register they feed.
  (CI itself runs green on every push to main; LICENSE, NOTICE, SECURITY.md,
  and CONTRIBUTING.md now exist.)
- Clean-room deployment guide (podman/gVisor install, migrate, users, systemd),
  configuration manual, admin/user guides, knowledge-transfer materials.
- TLS guidance and reverse-proxy reference config (cookie Secure flag already
  keys off X-Forwarded-Proto).

## mWater migration (post-OSS)

See mWater Migration.md: v1 compat wrapper, executeScript on the runner,
delete isolated-vm.

---
name: Incremental ingestion
description: Cursor state, per-run caps, publication lag, /work caching, and backfill - the pattern for periodic sources
verified: 2026-08-09
---

# Incremental ingestion

The standard shape for any source that publishes on a schedule. Gets three
properties at once: runs stay short, connectivity gaps self-heal, and
reprocessing is safe.

## Cursor in previousState

Return `state: {last_<period>: <key>}` from each run; start the next run at
the period after the cursor (`ctx.previous_state` / `previousState`, null on
the first and on cold runs). A missed schedule tick costs nothing — the next
run picks up where the cursor points, so backfill after downtime is
automatic, not a special mode.

## Cap work per run

Bound the periods processed per run (e.g. 12 months) so a deep backfill
makes progress inside the job timeout instead of dying at 90%. The
scheduler's next tick continues from the advanced cursor.

## Publication lag is not an error

For the trailing edge, a missing remote file usually means "not published
yet". Stop the loop cleanly and return the cursor as of the last ingested
period; never fail the run for a trailing 404. Reserve errors for genuinely
broken fetches (network failures, 500s, malformed files).

## /work is a cache, never the source of truth

Cache raw downloads in `ctx.work_dir` keyed by period; write via a `.part`
temp name and rename (atomic, so a killed run never leaves a truncated file
that a later run trusts). Cold runs wipe /work — code must work from
nothing, and the cache only makes it faster. Only what a later run reuses
belongs in /work: intermediates (unpacked archives, VRTs, GeoTIFFs before COG
conversion) go in `ctx.tmp_dir`, which is this run's own disk and is removed
afterwards, so they never pile up against the /work quota.

Atomic rename is not enough for artifacts **built in stages** (a COG that
gets overviews attached after creation, an archive assembled from parts):
a run killed between stages leaves a file that exists, opens, and is wrong.
Before reusing any staged cached artifact, validate its structure (expected
bands, overview levels, row counts) and rebuild on failure — a worker kill
mid-run is routine (deploys, restarts, timeouts), not exceptional.

## Emit empty periods through the same pipeline

When a period legitimately has no source data (no satellite pass, no
readings), emit its artifact through the SAME code path as a normal period
— an all-nodata raster still gets its full overview pyramid, metadata, and
validation. A special-cased "empty" branch skips steps the normal path has
and rots into the one path that never got tested.

## Reprocessing and backfill

- Operators reprocess with a rebuild: a run with null previousState and an
  empty /work. Code that produces everything in scope from null state needs
  nothing more. When the first run's history depth is a real choice, declare
  it as a setting (e.g. `months_back`, `appliesOn: "rebuild"`) and read it
  from `params` only when previousState is null, so scheduled runs stay
  incremental.
- Table destinations that re-ingest overlapping periods should use
  `action: "merge"` with mergeColumns on the period key, so reprocessing is
  idempotent instead of duplicating rows.
- Raster time-series layers are naturally idempotent per timestamp; re-runs
  supersede.

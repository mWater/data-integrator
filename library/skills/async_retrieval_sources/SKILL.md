---
name: Async retrieval sources
description: Technique - building on queued/packaging download APIs without getting wedged; prove fulfilment early, prefer direct object access, resumable task state
verified: 2026-08-27
---

# Queued and packaging download services

Many providers serve data through an asynchronous job API: you submit a
request, the service packages the subset, you poll and download. Some work
dependably (the ECMWF datastores). Some accept every request and fulfil
none. Design for both.

## Prove fulfilment before you build

**Submit a minimal real request during scoping - one date, a tiny bounding
box - and wait for an actual artifact before designing the integration
around the service.** A queue that acknowledges requests proves nothing;
only a downloaded file does. Certification requires a successful cold run,
so a service that never delivers blocks the whole design at the end, after
everything else is written - the most expensive possible place to discover
it. If the probe has not fulfilled within the session, treat the service as
unavailable and say so rather than certifying on faith.

## Look for a second door

The same dataset is very often published twice: the packaging API for
casual users, and direct file or object-store access (S3-compatible
buckets, plain HTTPS directories, mirrors) for bulk users. Direct access
to cloud-optimized files beats any packaging queue: no wait, no per-request
date caps, range reads fetch only the AOI's bytes, and there is nothing to
poll. When a queue misbehaves, finding the object store the packager reads
from is usually the fix (CLMS's stalled download API vs the same COGs in
CDSE S3; GFM's timing-out authenticated REST API vs the same rasters free
in the EODC STAC catalogue).

## If the queue is the only door

- **Submit once, remember forever.** Persist task ids in `previousState`
  the moment they are accepted; on every run, resume polling recorded
  tasks before submitting anything new. Never resubmit what is already
  queued - runs are cheap, duplicate jobs are not.
- **Batch dates** into as few requests as caps allow (per-month, not
  per-day): each job pays the queue toll once.
- **Cache downloads in /work** keyed by a digest of the request body, so
  re-runs and cold certification skip fulfilled work.
- **Bound every wait** with an explicit timeout and a clear error naming
  the service, and let the run fail cleanly - the next scheduled run
  resumes from recorded state. A daily-cadence integration tolerates a
  slow queue; a design session does not.
- **Expect tiers and revisions** (near-real-time vs consolidated): track
  which dates came from which tier and re-fetch when the better tier
  covers them.

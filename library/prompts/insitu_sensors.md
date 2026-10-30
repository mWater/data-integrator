# In-situ sensor readings

## Prompt

> Create an integration that receives in-situ sensor readings pushed to a
> webhook: groundwater levels and rainfall gauges. Each event is JSON with
> a station id, a timestamp, a variable name, a value, a unit, and
> optionally the station's coordinates. Store readings in a table keyed by
> station, variable, and timestamp, updating on re-delivery rather than
> duplicating, and keep a stations table with the latest known location of
> each station. Batch incoming events so at most one run happens per
> fifteen minutes.

## Scope

- No single national feed exists yet, so the entry is a generic receiver
  any sensor network can push to; a specific national service's format
  becomes a variant entry or a skill.
- Exercises the push path end to end: webhook trigger, batch window,
  webhookData consumption, tabular merge destinations.
- Pull-based sources (a public national or global API) can be a companion
  entry later; push is the architecturally interesting case.

## Acceptance checks

- Posting sample events to the capability URL lands rows after the batch
  window; re-posting the same event does not duplicate.
- Stations table shows one row per station with coordinates as geometry.
- A malformed event fails visibly in the run record without poisoning the
  batch.

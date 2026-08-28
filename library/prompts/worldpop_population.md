# Gridded population (WorldPop)

## Prompt

> Connect gridded population counts for the deployment's area of interest
> from WorldPop's constrained UN-adjusted 100 m annual series, using the
> most recent release. Store one snapshot per year on a time-series raster
> layer named "Population" so we can see change over time, covering the
> available years. Check monthly for newly published years.

## Scope

Population is the denominator for coverage analysis: people within reach of
a water point, people in a flood extent, people in a drought-affected area.
The constrained variant places population only on detected settlement,
which is what facility-coverage math needs.

## Acceptance

- Annual snapshots at native 100 m, clipped to the deployment AOI.
- Values are persons per pixel (float, nodata declared); AOI totals for a
  known year should be within a few percent of the country's published
  population.
- Major cities visibly dense; unsettled terrain nodata or zero.
- Rendering derived from observed values, not a theoretical global range.

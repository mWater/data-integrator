# HydroSHEDS basins and rivers

## Prompt

> Connect HydroSHEDS: river basins (HydroBASINS) and the river network
> (HydroRIVERS) for the region containing the deployment's area of
> interest. Store them as two tables with geometries: basins at a level
> of detail suitable for national reporting (roughly district-sized
> catchments), rivers with their upstream drainage area attribute. Static,
> no schedule.

## Scope

- HydroBASINS level 8 (adjust in steering if the AOI suggests otherwise)
  and HydroRIVERS, from the public HydroSHEDS downloads (registration-free
  license v1; record attribution).
- First vector-heavy entry: exercises table destinations via file
  artifacts (GeoPackage) rather than inline rows.
- Basin geometries are the joint surface for zonal statistics in derived
  integrations (rainfall per basin, population per basin).

## Acceptance checks

- Row counts in the right order of magnitude for the AOI region.
- Geometries valid, EPSG:4326, and basins tile the land area without gaps
  at a glance on the map view.
- A named major river is present and its drainage area attribute is
  plausible.

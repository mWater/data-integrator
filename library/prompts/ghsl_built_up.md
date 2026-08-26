# GHSL built-up surface

## Prompt

> Connect the Global Human Settlement Layer built-up surface (GHS-BUILT-S)
> from the EC Joint Research Centre. Use the most recent released epoch at
> 100 m resolution. This is a static dataset: ingest it once for the
> deployment's area of interest as a current-only raster layer named
> "Built-up surface", with square metres of built-up area per cell. No
> schedule; I will re-run it manually when JRC releases a new epoch.

## Scope

- GHS-BUILT-S, latest epoch, 100 m Mollweide grid, public JRC downloads,
  no account. Tiled product: the agent must fetch the tiles covering the
  AOI and mosaic.
- Current-only layer: a new epoch supersedes the old snapshot.
- Exposure denominators (population within built-up areas) come later as a
  derived integration; this entry only lands the surface.

## Acceptance checks

- Snapshot footprint covers the AOI; CRS recorded; nodata declared.
- Units are m2 per cell; values in [0, 10000] for 100 m cells.
- A known city centre in the AOI reads high; open water reads 0 or nodata.
- License recorded (CC-BY 4.0 with attribution to JRC).

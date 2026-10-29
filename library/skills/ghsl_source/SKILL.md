---
name: GHSL source
description: How JRC publishes GHSL grids (GHS-BUILT-S, GHS-POP, GHS-SMOD) - archive layout, Mollweide tile grid, zip contents, epochs, nodata
verified: 2026-09-17
---

# GHSL (Global Human Settlement Layer)

EC Joint Research Centre settlement grids: built-up surface (GHS-BUILT-S),
population (GHS-POP), settlement model (GHS-SMOD) and siblings. License
CC BY 4.0, attribution to JRC. Portal:
https://human-settlement.emergency.copernicus.eu/ (the download.php pages
are JavaScript-driven; scraping them is unreliable - use the open-data FTP
mirror below).

## Archive layout

Everything is on the JRC open-data mirror, no account:

    https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/
      GHS_BUILT_S_GLOBE_R2023A/
        GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100/V1-0/tiles/
          GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0_R11_C23.zip
          ...

Pattern: `GHS_<PRODUCT>_E<epoch>_GLOBE_<release>_<crs>_<res>/V1-0/tiles/`.
The directory listing is plain HTML; parse the `href="...zip"` entries to
learn which tiles exist rather than guessing. Ocean-only tiles are not
published, so a missing name is normal, not an error.

- Release R2023A carries epochs 1975-2030 in 5-year steps. **2020 is the
  latest observational epoch; 2025 and 2030 are model projections.** Do not
  treat projections as current observations without the operator asking.
- CRS variants: `54009` (World Mollweide, equal-area, native) at 100 m and
  1 km, and `4326` at 3/30 arcsec. Prefer the native Mollweide for
  anything summed per cell (m2, population counts): equal-area is what
  makes per-cell totals meaningful. Record the CRS as `ESRI:54009`.

## Tile grid (54009 products)

1000 km tiles on a fixed Mollweide grid, named `_R<row>_C<col>`:

- grid origin: left `-18041000`, top `9000000` (metres)
- rows 1-18 top-down, columns 1-37 left-right
- `col = floor((x - left) / 1000000) + 1`, `row = floor((top - y) / 1000000) + 1`

Transform the AOI's corners to Mollweide (pyproj), take the bounding box,
enumerate candidate row/col names, and intersect with the published listing.

## Tile grid (4326 products)

10-degree tiles, `_R<row>_C<col>`, rows 1-18 top-down, columns 1-36
left-right, only tiles with land published (GHS-POP: 348 per epoch). The
grid is **not** anchored at -180/90: tile R1_C1 starts at
`(-180.00791676306443, 89.099583459367)`, so derive row/col from that
origin (see `library/integrations/ghs_population`), never from round
numbers. Zips are ~90 MB for a populated tile, 12000x12000 pixels at 3ss.

## Zip contents

Each tile zip holds **one GeoTIFF plus sidecar files** (.tif.ovr, .clr,
metadata). Find the single `.tif` member rather than assuming the zip's
only file, and validate what you extracted by opening it: expect Mollweide
CRS and tiles **up to** 10000x10000 pixels at 100 m. **Edge tiles are
smaller than 10000x10000** - a strict size check rejects legitimate coastal
tiles.

## Values

- GHS-BUILT-S 100 m: UInt16 m2 of built-up surface per cell, 0-10000,
  nodata **65535**. Declare the nodata on the band as well as in the COG.
- Sea inside a tile is nodata; land with no buildings is 0. Both appear in
  normal AOIs.
- GHS-POP 4326 3ss: Float64 people per cell, LZW, 256-pixel blocks, no
  overviews, and **no nodata tag**: sea and empty land are both 0. Declare
  the documented nodata (-200) on the output so a box reaching past the
  published tiles is masked, and store as Float32 (counts per cell never
  need double). The 3ss product is the JRC's own resampling of the 100 m
  Mollweide one, on the same 3 arc-second grid as WorldPop, which is what a
  4326-only raster store wants.
- GHS-POP epochs: R2023A carries 1975-2030 in 5-year steps; 2020 is the
  last observed epoch, 2025 and 2030 are projections.

## Ingestion pattern

The proven shape (see `library/integrations/ghs_built_surface`): static
source, manual trigger, current-only layer. Cache tile zips in /work
(atomic download to `.part`, rename), extract, `gdalbuildvrt` the tiles,
one `gdalwarp` with the AOI as a cutline staying in Mollweide
(`-t_srs ESRI:54009 -tr 100 100 -tap`), then `gdal_translate -of COG`.

For a global 4326 product (`library/integrations/ghs_population`), do not
mosaic: one COG per published tile per epoch, cached under /work so an
interrupted epoch resumes, and an epoch is one snapshot of ~350 sources.

---
name: GHSL source
description: How JRC publishes GHSL grids (GHS-BUILT-S, GHS-POP, GHS-SMOD) - archive layout, Mollweide tile grid, zip contents, epochs, nodata
verified: 2026-08-26
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

## Zip contents

Each tile zip holds **one GeoTIFF plus sidecar files** (.tif.ovr, .clr,
metadata). Find the single `.tif` member rather than assuming the zip's
only file, and validate what you extracted by opening it: expect Mollweide
CRS and tiles **up to** 10000x10000 pixels at 100 m. **Edge tiles are
smaller than 10000x10000** - a strict size check rejects legitimate coastal
tiles (this bit the first integration built from this source).

## Values

- GHS-BUILT-S 100 m: UInt16 m2 of built-up surface per cell, 0-10000,
  nodata **65535**. Declare the nodata on the band as well as in the COG.
- Sea inside a tile is nodata; land with no buildings is 0. Both appear in
  normal AOIs.

## Ingestion pattern

The proven shape (see `library/integrations/ghs_built_surface`): static
source, manual trigger, current-only layer. Cache tile zips in /work
(atomic download to `.part`, rename), extract, `gdalbuildvrt` the tiles,
one `gdalwarp` with the AOI as a cutline staying in Mollweide
(`-t_srs ESRI:54009 -tr 100 100 -tap`), then `gdal_translate -of COG`.
Keep GDAL subprocess output out of the job's stdout.

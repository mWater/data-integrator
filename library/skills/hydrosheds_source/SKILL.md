---
name: HydroSHEDS source
description: How HydroSHEDS publishes basins and rivers - archive layout, HydroBASINS levels, attribute semantics, invalid-geometry trait
verified: 2026-08-26
---

# HydroSHEDS (HydroBASINS, HydroRIVERS)

Global hydrographic framework derived from SRTM: nested basin polygons and
river network lines. Free for scientific, educational, and commercial use
under the HydroSHEDS license; keep the attribution. Docs:
https://www.hydrosheds.org/products/hydrobasins and .../hydrorivers

## Archives

Continental shapefile zips, plain HTTPS, no account:

    https://data.hydrosheds.org/file/HydroBASINS/standard/hybas_af_lev08_v1c.zip
    https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_af_shp.zip

- Continent codes: af, ar, as, au, eu, gr, na, sa, si. Pick regions by AOI
  intersection with the continental extents; an AOI can straddle two.
- Continental zips run to hundreds of MB and extract to more. Download them
  into /work, where they are cached between runs, and extract only the members
  you need into ctx.tmp_dir, which is removed after the run.

## HydroBASINS levels

Pfafstetter levels 1-12, one shapefile per level. Level 8 sub-basins
average roughly 700 km2 globally (Madagascar: 893 basins), a practical
district-scale reporting default; 7 is coarser (~4x larger), 9 finer.
Key attributes: HYBAS_ID, NEXT_DOWN (0 at outlets), PFAF_ID, SUB_AREA
(own area, km2), UP_AREA (total upstream), ENDO (endorheic flag),
COAST (coastal fringe flag).

## HydroRIVERS

One global-per-continent line layer, no level choice. **Reaches carry no
river names**; identity is HYRIV_ID plus topology (NEXT_DOWN). Useful
attributes: LENGTH_KM, UPLAND_SKM (upstream drainage, km2), DIS_AV_CMS
(modeled average discharge), ORD_STRA (Strahler order). Verify a load by
drainage area, not by name: Madagascar's largest (the Mangoky) peaks
around 56,000 km2.

## Gotchas

- **A few percent of HydroBASINS polygons fail ST_IsValid** (shapefile
  ring defects). Repair with make_valid at ingest or spatial SQL
  (ST_Contains, overlays) misbehaves on exactly the basins someone
  eventually queries.
- Filter features by AOI intersection but keep whole features; clipping
  basins or reaches destroys their area/topology semantics.
- Vector loads travel as FlatGeobuf/GeoPackage files in tables[], not
  inline rows: tens of thousands of geometries blow the stdout cap.
- Sanity totals: AOI-intersecting basins should sum to slightly more than
  the country's land area (border basins overhang the box).

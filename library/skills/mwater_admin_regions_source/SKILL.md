---
name: mWater admin regions source
description: How data.mwater.co publishes global administrative boundaries - latest.json and manifest layout, per-country GeoPackages, stable ids, hierarchy columns, level semantics, license caveats
verified: 2026-09-07
---

# mWater Administrative Regions (data.mwater.co)

Global administrative boundaries, country (level 0) down to level 5 where a
country has them, maintained by mWater on a GADM 2.8 base with national and
partner updates. CC BY 4.0; attribute "mWater Administrative Regions
(data.mwater.co), derived from GADM 2.8 with national and partner updates".
Plain HTTPS, no account, open CORS, immutable versioned releases. Agent guide:
https://data.mwater.co/llms.txt

Prefer the library entry `mwater_admin_regions` over writing a new loader;
reuse its `admin_regions` table as the boundaries input of derived
integrations (zonal statistics, population-weighted indicators).

## Discovery

    https://data.mwater.co/admin-regions/latest.json
      -> {"version": "2026-09-07", "url": ".../releases/2026-09-07/", "manifest": ".../manifest.json"}
    https://data.mwater.co/admin-regions/releases/{version}/manifest.json

Read `latest.json` once, then use the versioned URLs it gives you; releases
never change after publication, so a pinned version is reproducible. The
manifest carries `schema` (column docs), `files` (global GeoParquet, attribute
CSV, level names CSV) and `countries`: one entry per country with `iso3`,
`name`, `bbox` [west, south, east, north], `levelNames` ({"1": "Province",
"2": "District", ...}), `counts` (rows per level) and `file` {path, bytes,
sha256}. Verify downloads against `bytes` and `sha256`.

## Files

- `countries/{ISO3}.gpkg`: everything for one country, two layers of identical
  columns: `admin_regions` (full geometry, for analysis) and
  `admin_regions_simplified` (for maps). Sizes run from under 1 MB to about
  60 MB (Madagascar, with fokontany). geopandas reads it directly; GDAL reads
  it in place with `/vsicurl/`.
- `admin_regions.parquet`, `admin_regions_simplified.parquet`: the whole world
  as GeoParquet (ZSTD). Only for global work; a country file is much smaller.
- `admin_regions.csv.gz`: attributes only, includes rows without geometry.
- `admin_region_levels.csv`: `iso3, country, level, name`, what each level is
  called in each country.

## Columns

`id` (stable mWater integer id, the join key), `iso3`, `level`, `name`,
`local_name`, `full_name` ("Toamasina I, Atsinanana, Madagascar"), `type`,
`local_type`, `leaf` (no further subdivisions), `parent_id`, `level0` ...
`level5` (containing region id at each level; `level0` is always the country
row's id), `source` ("GADM 2.8" or "mWater"), `geometry` (MultiPolygon,
EPSG:4326).

- Pick a hierarchy level with `where level = N`, never by `type` text, which
  varies by country and language. `levelNames` in the manifest (or
  `admin_region_levels.csv`) says what level N means locally.
- `leaf = 1` selects the finest regions across a country even where depth
  varies (some districts subdivide further than others).
- A district's province is `level1`, no self-join needed. `parent_id` is the
  immediate container.
- Country row: `level = 0`, `parent_id` null, `level0 = id`.

## Gotchas

- Countries are keyed by ISO 3166-1 alpha-3. Take codes from the runtime AOI
  (`aoi.countries`), like WorldPop. Only
  fall back to bbox intersection with the manifest `bbox` values when no
  country list exists, and expect neighbours to appear.
- No AOI at all (the integration set to the source's full extent, or a
  deployment without a default) means the whole world: every published
  country, about 3 GB of geometry. Feasible, but stream it one country at a
  time into one GeoPackage in /out rather than concatenating in memory, and
  give the run an hour.
- Territories without an official ISO code use GADM-style X codes: XKO
  Kosovo, XNC Northern Cyprus, XAD Akrotiri and Dhekelia, XCA Caspian Sea,
  XCL Clipperton, XPI Paracel Islands, XSP Spratly Islands.
- A handful of geometries fail `is_valid`. Run `make_valid` at load or
  overlays throw on exactly the region someone eventually queries.
- Vector loads travel as FlatGeobuf files in `tables[]`, not inline rows.
- Geometry-only edits between releases are not in `CHANGELOG.md` (it lists
  added, removed, renamed and moved regions from attributes). Compare
  `sha256` of a country file across manifests to detect them.
- The `source` column lets a consumer drop GADM-derived rows if GADM's
  redistribution terms matter to them; mWater publishes the dataset as a
  public good and states this in the manifest.

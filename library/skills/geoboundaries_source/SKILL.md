---
name: geoBoundaries source
description: How geoBoundaries publishes administrative boundaries - the open release API, one dataset per country and level, per-boundary licenses and sources, GeoJSON properties, no hierarchy, pitfalls
verified: 2026-11-24
---

# geoBoundaries administrative boundaries

Administrative boundaries for about 230 countries from the William & Mary
geoLab, level 0 (the country outline) down to level 5 where a country has
them. Plain HTTPS, no account. Site: https://www.geoboundaries.org. Cite
Runfola et al. (2020), "geoBoundaries: A global database of political
administrative boundaries", PLoS ONE 15(4).

Prefer the library entry `geoboundaries_admin_boundaries` over writing a new
loader; use its `admin_boundaries` table as the boundaries input of derived
integrations (zonal statistics, population-weighted indicators).

## Releases

Three releases share one API shape. Use `gbOpen` only.

- `gbOpen`: openly licensed boundaries. The license differs per boundary
  (see below).
- `gbHumanitarian`: mirrored from UN OCHA. Some are derived from GADM, whose
  license allows neither commercial use nor redistribution (Angola's lists
  "www.gadm.org" as a source).
- `gbAuthoritative`: mirrored from UN SALB under its own data license, and
  missing for many countries.

## Discovery

    https://www.geoboundaries.org/api/current/gbOpen/{ISO3}/{ADMn}/
    https://www.geoboundaries.org/api/current/gbOpen/{ISO3}/ALL/
    https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/

`ALL` works in either position. One level answers with a bare JSON object,
several with a list, so normalize. An unknown country answers 404. The whole
listing (`ALL/ALL`) is about 1.3 MB for some 700 records.

Each record describes one country at one level:

- `boundaryID` (`MDG-ADM2-...`), `boundaryISO`, `boundaryName` (the country),
  `boundaryType` (`ADM0`..`ADM5`)
- `boundaryCanonical`: the local name of the level ("districts"), or
  `Unknown`
- `boundaryYearRepresented`: usually a year, occasionally a date range
- `boundarySource`, `boundarySourceURL`, `boundaryLicense`, `licenseSource`,
  `licenseDetail`
- `admUnitCount`, `buildDate`, `sourceDataUpdateDate`
- `gjDownloadURL` (full GeoJSON), `simplifiedGeometryGeoJSON`,
  `tjDownloadURL` (TopoJSON), `staticDownloadLink` (zip)

Missing values arrive as the strings `nan` or `Unknown`, not JSON null.

## Files

Download URLs point at github.com and name a commit of the geoBoundaries
repository, so a file fetched from a URL never changes; a new release has a
new URL. Cache by URL. github.com answers with a redirect to the file, so
follow redirects.

GeoJSON in CRS84 (longitude, latitude). Feature properties:

- `shapeID`: unique per feature, the same in the full and simplified files
- `shapeName`
- `shapeISO`: ISO 3166-2 code where the source has one; often empty below
  level 1
- `shapeGroup` (the ISO3 code), `shapeType` (`ADM2`)

Sizes vary widely. Angola's four levels total about 29 MB; Madagascar level
4 (17,465 units) is 80 MB in full and 17 MB simplified.

## Licenses

There is no single license. Each record carries its own, and one country's
levels often come from different sources under different terms: Madagascar
levels 0 and 1 are OpenStreetMap under ODbL 1.0, levels 2 to 4 are from the
national disaster office under CC BY 3.0 IGO. Across the open release the
common ones are ODbL 1.0, CC BY (3.0 IGO, 4.0), CC BY-SA, public domain and
CC0. A handful carry other terms ("Other - Direct Permission", a national
statistics office license). Keep `boundaryLicense` and `boundarySource` with
the data, and show them wherever the boundaries are republished.

## Pitfalls

- No hierarchy. Levels are independent datasets with no parent ids, and
  because they come from different sources they need not nest exactly.
  Relate levels spatially (a point on the child's surface inside the parent)
  when a hierarchy is needed.
- Age. Many boundaries are several years old and predate later
  administrative reforms. `boundaryYearRepresented` says which year each one
  shows; compare unit counts with the current national structure before
  relying on them.
- `admUnitCount` can differ slightly from the features in the file. Count
  what was loaded.
- A country can be absent, or have fewer levels than expected. Treat a 404
  and a missing level as "not published", not as an error.
- Boundaries imply no position on the legal status of any territory.

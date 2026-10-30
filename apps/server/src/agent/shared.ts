/** Prompt/schema building blocks shared by the SQL-facing agents. */

import pg from "pg"
import { localizeString } from "@data-integrator/definitions"
import { listTables } from "../queryApi.js"
import { describeAoi } from "../aoi.js"

/**
 * Raster-SQL guidance interpolated into agent prompts. Examples use $1
 * placeholders; agents that inline literals say so beside the interpolation.
 */
export const RASTER_SQL_GUIDE = `The rasters table mirrors promoted raster snapshots as tiled out-db PostGIS
rasters: layer_id, snapshot_id, observed_at, observed_end, rast. Pixel reads
go straight to the underlying files, so raster values compose with vector
rows in ordinary SQL. Sample at features (band index from the layer list):
  SELECT wp.name, ST_Value(r.rast, 1, wp.geom) AS spi3
  FROM water_points wp
  JOIN rasters r ON r.layer_id = 'spi3'
    AND ST_Intersects(ST_ConvexHull(r.rast), wp.geom)
  WHERE r.observed_at = $1
Statistics "of the country" or "of the area": the deployment's area of
interest is a real shape, not its bounding box. The aoi table holds it (one
row: name, geom, land_area_km2, boundary_source); it is land only, lakes
removed. Use the function, never an envelope:
  SELECT * FROM aoi_stats('spi3', $1, -1, '<')
  -> mean (area-weighted), share (of land meeting the condition), coverage
     (share of land with a valid pixel), cells, cell_km2, method,
     observed_at, observed_end, boundary
Arguments: layer_id, at (date; the snapshot on or before it, null = newest),
threshold, op (< <= > >= =), band. Coarse pixels are weighted by the part of
each that lies inside the boundary; nodata is excluded. A statistic over an
envelope counts ocean and neighbours and is wrong for any "percent of the
country" claim. When you report a share from a grid coarser than about
10 km, say the cell size and the coverage with it.
Zonal statistics over some other area (a basin, a buffer; aggregate across
tiles), clip to that geometry:
  SELECT sum((stats).sum) / sum((stats).count) AS mean FROM (
    SELECT ST_SummaryStats(ST_Clip(r.rast, b.geom, true)) AS stats
    FROM rasters r JOIN hydrobasins b ON ST_Intersects(ST_ConvexHull(r.rast), b.geom)
    WHERE r.layer_id = '...' AND r.observed_at = $1 AND b.hybas_id = ...) t
Always filter layer_id, observed_at (time-series layers have one snapshot per
period), and spatially via ST_Intersects(ST_ConvexHull(rast), ...) so only
the needed tiles are read. Keep clipped areas modest - the 15s timeout is
real; never scan a whole layer unfiltered. For buffers in meters cast through
geography: ST_Buffer(geom::geography, 500)::geometry.
Nodata discipline: bands do not always declare their nodata value, so
sentinel pixels (-9999, or float minima near -3.4e+38 that ST_Clip fills
outside the clip geometry) can pollute samples and statistics. Sanity-check
min/max against the band's units; when sentinels appear, exclude them
explicitly (e.g. WHERE sampled_value > -9000 for physical quantities, or a
NULLIF/threshold inside the aggregate) before presenting numbers.
SQL's honest reach is sampling, clipping, zonal statistics, and buffers over
data as it stands. Deriving new products - resampling or aligning grids,
reprojection, raster algebra across mismatched grids, hydrological or other
modeling - is integration work in Python, not something to approximate in a
query.`

/**
 * Describes the queryable surface for an agent: data tables with display
 * names, columns, types, and units, plus installed raster layers with band
 * indexes and tile colorMaps. Display names resolve to the given locale so
 * the agent titles things the way the user's catalog does.
 */
export async function describeSchema(pool: pg.Pool, locale = "en"): Promise<string> {
  const tables = await listTables(pool)
  const tableBlock =
    tables.length === 0
      ? "(no data tables exist yet)"
      : tables
          .map((t) => {
            const display = t.name ? ` "${localizeString(t.name, locale)}"` : ""
            const about = t.description ? ` - ${localizeString(t.description, locale)}` : ""
            return `${t.tableId}${display}${about}: ${t.columns
              .map((c) => `${c.id} ${c.type}${c.units ? ` (${c.units})` : ""}`)
              .join(", ")}`
          })
          .join("\n")
  // Raster layers queryable through the rasters table (band index = position)
  const layers = await pool.query(
    "SELECT id, name, temporality, bands FROM app.raster_layers WHERE integration_id IS NOT NULL ORDER BY id"
  )
  const layerBlock =
    layers.rows.length === 0
      ? ""
      : "\n\nRaster layers (in the rasters table; band index in file order):\n" +
        layers.rows
          .map(
            (l: {
              id: string
              name: { _base: string; [locale: string]: string }
              temporality: string
              bands: { id: string; units?: string; rendering?: { colorMap?: { value: number; color: string }[] } }[]
            }) =>
              `${l.id} "${localizeString(l.name, locale)}" (${l.temporality}): ${l.bands
                .map((b, i) => {
                  const ramp = b.rendering?.colorMap ? `, tile colorMap ${JSON.stringify(b.rendering.colorMap)}` : ""
                  return `band ${i + 1}=${b.id}${b.units ? ` (${b.units})` : ""}${ramp}`
                })
                .join(", ")}`
          )
          .join("\n")
  // The area of interest as a shape: what "of the country" statistics clip to
  const aoi = await describeAoi(pool)
  const aoiBlock = aoi
    ? `\n\nArea of interest (aoi table, one row; aoi_stats() for statistics over it): ${aoi}`
    : "\n\nNo area of interest is configured, so aoi_stats() is unavailable; say so if asked for a share of the country."
  return tableBlock + layerBlock + aoiBlock
}

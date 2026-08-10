/** Prompt/schema building blocks shared by the SQL-facing agents. */

import pg from "pg"
import { listTables } from "../queryApi.js"

/**
 * Raster-SQL guidance interpolated into agent prompts. Examples use $1
 * placeholders; agents that inline literals say so beside the interpolation.
 */
export const RASTER_SQL_GUIDE = `The rasters table mirrors promoted raster snapshots as tiled out-db PostGIS
rasters: layer_id, snapshot_id, observed_at, observed_end, rast. Pixel reads
go straight to the underlying files, so raster values compose with vector
rows in ordinary SQL. Sample at features (band index from the layer list):
  SELECT wp.name, ST_Value(r.rast, 1, wp.geom) AS rain
  FROM water_points wp
  JOIN rasters r ON r.layer_id = 'chirps_rainfall'
    AND ST_Intersects(ST_ConvexHull(r.rast), wp.geom)
  WHERE r.observed_at = $1
Zonal statistics over an area (aggregate across tiles):
  SELECT sum((stats).sum) / sum((stats).count) AS mean FROM (
    SELECT ST_SummaryStats(ST_Clip(r.rast, ST_MakeEnvelope(...,4326))) AS stats
    FROM rasters r WHERE r.layer_id = '...' AND r.observed_at = $1
      AND ST_Intersects(ST_ConvexHull(r.rast), ST_MakeEnvelope(...,4326))) t
Always filter layer_id, observed_at (time-series layers have one snapshot per
period), and spatially via ST_Intersects(ST_ConvexHull(rast), ...) so only
the needed tiles are read. Keep clipped areas modest - the 15s timeout is
real; never scan a whole layer unfiltered. For buffers in meters cast through
geography: ST_Buffer(geom::geography, 500)::geometry.`

/**
 * Describes the queryable surface for an agent: data tables with columns,
 * types, and units, plus installed raster layers with band indexes and tile
 * colorMaps.
 */
export async function describeSchema(pool: pg.Pool): Promise<string> {
  const tables = await listTables(pool)
  const tableBlock =
    tables.length === 0
      ? "(no data tables exist yet)"
      : tables
          .map(
            (t) =>
              `${t.tableId}: ${t.columns.map((c) => `${c.id} ${c.type}${c.units ? ` (${c.units})` : ""}`).join(", ")}`
          )
          .join("\n")
  // Raster layers queryable through the rasters table (band index = position)
  const layers = await pool.query(
    "SELECT id, temporality, bands FROM app.raster_layers WHERE integration_id IS NOT NULL ORDER BY id"
  )
  const layerBlock =
    layers.rows.length === 0
      ? ""
      : "\n\nRaster layers (in the rasters table; band index in file order):\n" +
        layers.rows
          .map(
            (l: {
              id: string
              temporality: string
              bands: { id: string; units?: string; rendering?: { colorMap?: { value: number; color: string }[] } }[]
            }) =>
              `${l.id} (${l.temporality}): ${l.bands
                .map((b, i) => {
                  const ramp = b.rendering?.colorMap ? `, tile colorMap ${JSON.stringify(b.rendering.colorMap)}` : ""
                  return `band ${i + 1}=${b.id}${b.units ? ` (${b.units})` : ""}${ramp}`
                })
                .join(", ")}`
          )
          .join("\n")
  return tableBlock + layerBlock
}

/**
 * The area of interest as a shape. The default_aoi setting is a bounding box
 * plus country codes; this module turns it into the single data.aoi row
 * (land only, lakes removed) that statistics and, later, map masks clip to.
 * Boundaries come from Natural Earth 1:10m, bundled so a deployment needs
 * nothing from the network; a deployment can later point at its own
 * authoritative boundary table instead.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import pg from "pg"
import { DefaultAoi } from "./settings.js"

/** Where the bundled boundary files live. */
const BOUNDARIES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "boundaries")

/** Provenance recorded on the AOI row and reported by aoi_stats. */
export const BOUNDARY_SOURCE = "Natural Earth 1:10m Admin 0 countries, lakes removed"

/** Natural Earth release the bundled files were taken from. */
export const BOUNDARY_VERSION = "5.1.1"

/** A GeoJSON feature as the bundled files carry it. */
interface Feature {
  type: "Feature"
  properties: Record<string, unknown>
  geometry: { type: string; coordinates: unknown }
}

/** Parsed boundary files, loaded once per process. */
let cache: { countries: Feature[]; lakes: Feature[] } | null = null

/** Loads and parses the bundled boundary files (about 15 MB of GeoJSON, once). */
async function loadBoundaries(): Promise<{ countries: Feature[]; lakes: Feature[] }> {
  if (cache) return cache
  const read = async (name: string): Promise<Feature[]> => {
    const gz = await readFile(path.join(BOUNDARIES_DIR, name))
    return (JSON.parse(gunzipSync(gz).toString("utf8")) as { features: Feature[] }).features
  }
  cache = {
    countries: await read("ne_10m_admin_0_countries.geojson.gz"),
    lakes: await read("ne_10m_lakes.geojson.gz")
  }
  return cache
}

/**
 * Areas Natural Earth draws as their own feature (by ADM0_A3) that ISO 3166
 * has no code for and folds into a country: selecting the country takes them
 * too, matching the ISO view and the deployment's administrative regions.
 */
const FOLDED_TERRITORIES: Record<string, string[]> = {
  SOM: ["SOL"]
}

/** Country features for ISO3 codes: Natural Earth's ISO_A3_EH first, then its own ADM0_A3. */
function countryFeatures(countries: Feature[], codes: string[]): Feature[] {
  const wanted = new Set(codes.map(c => c.toUpperCase()))
  for (const code of [...wanted]) for (const folded of FOLDED_TERRITORIES[code] ?? []) wanted.add(folded)
  return countries.filter(f => wanted.has(String(f.properties.ISO_A3_EH)) || wanted.has(String(f.properties.ADM0_A3)))
}

/** True when any coordinate of the geometry falls inside the box (cheap prefilter). */
function touchesBox(geometry: Feature["geometry"], box: [number, number, number, number]): boolean {
  const [west, south, east, north] = box
  const inside = (lon: number, lat: number) =>
    lat >= south && lat <= north && (west <= east ? lon >= west && lon <= east : lon >= west || lon <= east)
  const walk = (coords: unknown): boolean => {
    if (!Array.isArray(coords)) return false
    if (typeof coords[0] === "number") return inside(coords[0] as number, coords[1] as number)
    return coords.some(walk)
  }
  return walk(geometry.coordinates)
}

/** The box as WKT, split in two when it crosses the antimeridian. */
function boxWkt([west, south, east, north]: [number, number, number, number]): string {
  const rect = (w: number, e: number) => `((${w} ${south},${e} ${south},${e} ${north},${w} ${north},${w} ${south}))`
  return west <= east ? `POLYGON${rect(west, east)}` : `MULTIPOLYGON(${rect(west, 180)},${rect(-180, east)})`
}

/**
 * SQL producing a country-shaped area: the countries' outlines minus lakes,
 * cut to the box, as a MultiPolygon. Null when the codes match no boundary.
 * The expression references $1 (box WKT), $2 (countries GeoJSON), $3 (lakes
 * GeoJSON), which the returned params carry in that order.
 */
async function countryShape(
  codes: string[],
  box: [number, number, number, number]
): Promise<{ sql: string; params: string[] } | null> {
  const { countries, lakes } = await loadBoundaries()
  const found = countryFeatures(countries, codes)
  if (found.length === 0) return null
  const nearbyLakes = lakes.filter(l => touchesBox(l.geometry, box))
  return {
    // ST_CollectionExtract keeps the polygons should the difference leave
    // slivers of lower dimension
    sql: `ST_Multi(ST_CollectionExtract(ST_Intersection(
            ST_Difference(
              ST_UnaryUnion(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))),
              ST_UnaryUnion(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))
            ),
            ST_GeomFromText($1, 4326)), 3))`,
    params: [
      boxWkt(box),
      JSON.stringify({ type: "GeometryCollection", geometries: found.map(f => f.geometry) }),
      JSON.stringify({ type: "GeometryCollection", geometries: nearbyLakes.map(l => l.geometry) })
    ]
  }
}

/**
 * Rebuilds data.aoi from the deployment's default area of interest. With
 * countries, the shape is their Natural Earth outlines minus lakes, cut to
 * the box; a bare box is a rectangle; null clears the row. Idempotent. Layer
 * masks follow, since inheriting layers take this shape.
 */
export async function refreshAoi(pool: pg.Pool, aoi: DefaultAoi | null): Promise<void> {
  if (!aoi) {
    await pool.query("DELETE FROM data.aoi")
    await refreshLayerMasks(pool)
    return
  }
  const codes = aoi.countries ?? []
  const box = aoi.bbox
  let geomSql = "ST_Multi(ST_GeomFromText($1, 4326))"
  let params: unknown[] = [boxWkt(box)]
  let source = "Bounding box"
  if (codes.length > 0) {
    const shape = await countryShape(codes, box)
    if (!shape) throw new Error(`No boundary for country codes ${codes.join(", ")}`)
    geomSql = shape.sql
    params = shape.params
    source = BOUNDARY_SOURCE
  }
  params.push(aoi.name ?? null, codes, box, source, codes.length > 0 ? BOUNDARY_VERSION : "n/a")
  const n = params.length
  await pool.query(
    `INSERT INTO data.aoi (id, name, countries, bbox, geom, land_area_km2, boundary_source, boundary_version, updated_at)
     SELECT 1, $${n - 4}, $${n - 3}::text[], $${n - 2}::float8[], g.geom, ST_Area(g.geom::geography) / 1e6, $${n - 1}, $${n}, now()
     FROM (SELECT ${geomSql} AS geom) g
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, countries = EXCLUDED.countries, bbox = EXCLUDED.bbox, geom = EXCLUDED.geom,
       land_area_km2 = EXCLUDED.land_area_km2, boundary_source = EXCLUDED.boundary_source,
       boundary_version = EXCLUDED.boundary_version, updated_at = now()`,
    params
  )
  await refreshLayerMasks(pool)
}

/**
 * Rebuilds the map mask of every installed raster layer (or one integration's)
 * from its integration's effective area of interest: an inherited default
 * takes the deployment shape; explicit countries take their own outline; an
 * explicit box or the source's full extent means no mask. Rendering only.
 */
export async function refreshLayerMasks(pool: pg.Pool, integrationId?: string): Promise<void> {
  const rows = await pool.query(
    `SELECT id, definition -> 'aoi' AS aoi, definition ? 'aoi' AS has_aoi FROM app.integrations
     WHERE EXISTS (SELECT 1 FROM app.raster_layers l WHERE l.integration_id = app.integrations.id AND l.session_id IS NULL)
       ${integrationId ? "AND id = $1" : ""}`,
    integrationId ? [integrationId] : []
  )
  for (const row of rows.rows) {
    const aoi = row.aoi as (DefaultAoi | null) | undefined
    if (!row.has_aoi) {
      // Inherits the deployment default: share its shape (or none)
      await pool.query(
        `UPDATE app.raster_layers SET mask_geom = (SELECT geom FROM data.aoi)
         WHERE integration_id = $1 AND session_id IS NULL`,
        [row.id]
      )
      continue
    }
    const codes = aoi?.countries ?? []
    const shape = aoi && codes.length > 0 ? await countryShape(codes, aoi.bbox) : null
    if (!shape) {
      await pool.query("UPDATE app.raster_layers SET mask_geom = NULL WHERE integration_id = $1 AND session_id IS NULL", [
        row.id
      ])
      continue
    }
    await pool.query(
      `UPDATE app.raster_layers SET mask_geom = (SELECT ${shape.sql})
       WHERE integration_id = $4 AND session_id IS NULL`,
      [...shape.params, row.id]
    )
  }
}

/** One-line description of the configured area, for agent prompts; null when none. */
export async function describeAoi(pool: pg.Pool): Promise<string | null> {
  const result = await pool.query(
    "SELECT name, countries, land_area_km2, boundary_source, boundary_version FROM data.aoi"
  )
  const row = result.rows[0]
  if (!row) return null
  const label = row.name ?? (row.countries.length > 0 ? row.countries.join(", ") : "custom box")
  return `${label}: land area ${Math.round(row.land_area_km2).toLocaleString("en-US")} km², boundary ${row.boundary_source} ${row.boundary_version}`
}

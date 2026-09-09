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

/** Country features for ISO3 codes: Natural Earth's ISO_A3_EH first, then its own ADM0_A3. */
function countryFeatures(countries: Feature[], codes: string[]): Feature[] {
  const wanted = new Set(codes.map(c => c.toUpperCase()))
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
 * Rebuilds data.aoi from the deployment's default area of interest. With
 * countries, the shape is their Natural Earth outlines minus lakes, cut to
 * the box; a bare box is a rectangle; null clears the row. Idempotent.
 */
export async function refreshAoi(pool: pg.Pool, aoi: DefaultAoi | null): Promise<void> {
  if (!aoi) {
    await pool.query("DELETE FROM data.aoi")
    return
  }
  const codes = aoi.countries ?? []
  const box = aoi.bbox
  let geomSql: string
  const params: unknown[] = [boxWkt(box)]
  let source = "Bounding box"
  if (codes.length > 0) {
    const { countries, lakes } = await loadBoundaries()
    const found = countryFeatures(countries, codes)
    if (found.length === 0) throw new Error(`No boundary for country codes ${codes.join(", ")}`)
    const nearbyLakes = lakes.filter(l => touchesBox(l.geometry, box))
    params.push(
      JSON.stringify({ type: "GeometryCollection", geometries: found.map(f => f.geometry) }),
      JSON.stringify({ type: "GeometryCollection", geometries: nearbyLakes.map(l => l.geometry) })
    )
    // Countries, minus lakes, cut to the box; ST_CollectionExtract keeps the
    // polygons should the difference leave slivers of lower dimension
    geomSql = `ST_Multi(ST_CollectionExtract(ST_Intersection(
                 ST_Difference(
                   ST_UnaryUnion(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))),
                   ST_UnaryUnion(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))
                 ),
                 ST_GeomFromText($1, 4326)), 3))`
    source = BOUNDARY_SOURCE
  } else {
    geomSql = "ST_Multi(ST_GeomFromText($1, 4326))"
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

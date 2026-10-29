/**
 * Read-only STAC API (core, collections, item search per collection) over
 * the raster catalog: one Collection per installed raster layer, one Item
 * per promoted snapshot with its COG files as assets. It is a view, not a
 * second catalog: everything comes from the same rows /api/layers reads,
 * and assets link to the existing snapshot download route, so access
 * control and file serving stay in one place.
 */

import pg from "pg"
import { localizeString, LocalizedString, SourceInfo } from "@data-integrator/definitions"

/** STAC version the documents declare. */
export const STAC_VERSION = "1.0.0"

/** Conformance classes this API implements. */
export const STAC_CONFORMANCE = [
  "https://api.stacspec.org/v1.0.0/core",
  "https://api.stacspec.org/v1.0.0/collections",
  "https://api.stacspec.org/v1.0.0/ogcapi-features",
  "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
  "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson"
]

/** Media type of the COG assets. */
const COG_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized"

/** Items per page by default and at most. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** A STAC link object. */
interface Link {
  /** Relation type */
  rel: string
  /** Absolute URL */
  href: string
  /** Media type */
  type?: string
  /** Display title */
  title?: string
}

/** Item search parameters for one collection. */
export interface ItemQuery {
  /** Page size */
  limit: number
  /** Only items observed strictly before this instant (the paging cursor) */
  before: string | null
  /** Inclusive datetime interval; null bounds are open */
  datetime: { start: string | null; end: string | null } | null
  /** WGS84 [west, south, east, north] the footprint must intersect */
  bbox: [number, number, number, number] | null
}

/** Parses limit, datetime, bbox and the paging token; throws with a message for a 400. */
export function parseItemQuery(params: URLSearchParams): ItemQuery {
  const limitRaw = params.get("limit")
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")

  const instant = (value: string, name: string): string | null => {
    if (value === ".." || value === "") return null
    if (Number.isNaN(Date.parse(value))) throw new Error(`${name} is not an RFC 3339 date-time: ${value}`)
    return new Date(value).toISOString()
  }
  const datetimeRaw = params.get("datetime")
  let datetime: ItemQuery["datetime"] = null
  if (datetimeRaw) {
    const parts = datetimeRaw.split("/")
    if (parts.length > 2) throw new Error("datetime must be an instant or an interval start/end")
    const start = instant(parts[0], "datetime")
    const end = parts.length === 2 ? instant(parts[1], "datetime") : start
    if (start === null && end === null) throw new Error("datetime interval needs at least one bound")
    datetime = { start, end }
  }

  const bboxRaw = params.get("bbox")
  let bbox: ItemQuery["bbox"] = null
  if (bboxRaw) {
    const values = bboxRaw.split(",").map(Number)
    if (values.length !== 4 || values.some(v => !Number.isFinite(v))) throw new Error("bbox must be west,south,east,north")
    bbox = values as [number, number, number, number]
  }

  const token = params.get("token")
  return { limit: Math.min(limit, MAX_LIMIT), before: token ? instant(token, "token") : null, datetime, bbox }
}

/** One installed raster layer as the collection document reads it. */
interface LayerRow {
  id: string
  name: LocalizedString
  bands: { id: string; name?: LocalizedString; units?: string; nodata?: number }[]
  integration_description: LocalizedString | null
  source: SourceInfo | null
  bbox: number[] | null
  first_at: Date | null
  last_at: Date | null
}

/** SQL selecting installed layers with their snapshot extent. */
const LAYER_SQL = `
  SELECT l.id, l.name, l.bands, i.definition->'description' AS integration_description, i.definition->'source' AS source,
         e.bbox, e.first_at, e.last_at
  FROM app.raster_layers l
  JOIN app.integrations i ON i.id = l.integration_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(s.footprint) > 0 THEN ARRAY[
             ST_XMin(ST_Extent(s.footprint)), ST_YMin(ST_Extent(s.footprint)),
             ST_XMax(ST_Extent(s.footprint)), ST_YMax(ST_Extent(s.footprint))] END AS bbox,
           min(s.observed_at) AS first_at, max(coalesce(s.observed_end, s.observed_at)) AS last_at
    FROM app.raster_snapshots s WHERE s.layer_id = l.id AND s.status = 'promoted'
  ) e ON true
  WHERE l.session_id IS NULL`

/** A license string as STAC wants it: an SPDX id, else "other". */
function stacLicense(license: string | undefined): string {
  return license && /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(license) ? license : "other"
}

/** The Collection document for a layer. */
function collection(row: LayerRow, base: string, locale: string): object {
  const source = row.source
  const description = localizeString(row.integration_description ?? undefined, locale) || localizeString(row.name, locale)
  const links: Link[] = [
    { rel: "self", href: `${base}/collections/${row.id}`, type: "application/json" },
    { rel: "parent", href: base, type: "application/json" },
    { rel: "root", href: base, type: "application/json" },
    { rel: "items", href: `${base}/collections/${row.id}/items`, type: "application/geo+json" }
  ]
  if (source?.url) links.push({ rel: "via", href: source.url, title: localizeString(source.name, locale) })
  if (source?.documentation) links.push({ rel: "describedby", href: source.documentation })
  return {
    type: "Collection",
    stac_version: STAC_VERSION,
    id: row.id,
    title: localizeString(row.name, locale),
    description,
    license: stacLicense(source?.license),
    ...(source?.provider ? { providers: [{ name: source.provider, roles: ["producer", "licensor"], ...(source.url ? { url: source.url } : {}) }] } : {}),
    extent: {
      spatial: { bbox: [row.bbox ?? [-180, -90, 180, 90]] },
      temporal: { interval: [[row.first_at?.toISOString() ?? null, row.last_at?.toISOString() ?? null]] }
    },
    summaries: {
      bands: row.bands.map(b => ({
        name: b.id,
        ...(b.name ? { description: localizeString(b.name, locale) } : {}),
        ...(b.units ? { unit: b.units } : {}),
        ...(b.nodata !== undefined ? { nodata: b.nodata } : {})
      }))
    },
    links
  }
}

/** The landing page: a Catalog linking to every collection. */
export async function stacLanding(pool: pg.Pool, base: string, title: string): Promise<object> {
  const layers = await pool.query(`SELECT l.id FROM app.raster_layers l WHERE l.session_id IS NULL ORDER BY l.id`)
  return {
    type: "Catalog",
    stac_version: STAC_VERSION,
    id: "data-integrator",
    title,
    description: `Raster catalog of ${title}: one collection per layer, one item per published snapshot.`,
    conformsTo: STAC_CONFORMANCE,
    links: [
      { rel: "self", href: base, type: "application/json" },
      { rel: "root", href: base, type: "application/json" },
      { rel: "conformance", href: `${base}/conformance`, type: "application/json" },
      { rel: "data", href: `${base}/collections`, type: "application/json" },
      ...layers.rows.map(r => ({ rel: "child", href: `${base}/collections/${r.id}`, type: "application/json" }))
    ]
  }
}

/** All collections. */
export async function stacCollections(pool: pg.Pool, base: string, locale: string): Promise<object> {
  const result = await pool.query(`${LAYER_SQL} ORDER BY l.id`)
  return {
    collections: result.rows.map(row => collection(row, base, locale)),
    links: [
      { rel: "self", href: `${base}/collections`, type: "application/json" },
      { rel: "root", href: base, type: "application/json" }
    ]
  }
}

/** One collection, or null when no installed layer has the id. */
export async function stacCollection(pool: pg.Pool, base: string, locale: string, layerId: string): Promise<object | null> {
  const result = await pool.query(`${LAYER_SQL} AND l.id = $1`, [layerId])
  return result.rows.length === 0 ? null : collection(result.rows[0], base, locale)
}

/** One snapshot row as items read it. */
interface SnapshotRow {
  id: string
  observed_at: Date
  observed_end: Date | null
  created_at: Date
  /** Lineage the integration attached to the snapshot */
  metadata: Record<string, unknown> | null
  geometry: object
  bbox: number[]
  sources: number
}

/** The Item document for a snapshot. */
function item(layerId: string, row: SnapshotRow, base: string, apiBase: string): object {
  const assets: Record<string, object> = {}
  for (let ordinal = 0; ordinal < row.sources; ordinal++) {
    assets[row.sources === 1 ? "data" : `data-${ordinal}`] = {
      href: `${apiBase}/snapshots/${row.id}/download${ordinal > 0 ? `?source=${ordinal}` : ""}`,
      type: COG_TYPE,
      roles: ["data"]
    }
  }
  const properties = row.observed_end
    ? { datetime: null, start_datetime: row.observed_at.toISOString(), end_datetime: row.observed_end.toISOString() }
    : { datetime: row.observed_at.toISOString() }
  return {
    type: "Feature",
    stac_version: STAC_VERSION,
    id: row.id,
    collection: layerId,
    geometry: row.geometry,
    bbox: row.bbox,
    properties: {
      ...properties,
      created: row.created_at.toISOString(),
      ...(row.metadata ? { "integrator:metadata": row.metadata } : {})
    },
    assets,
    links: [
      { rel: "self", href: `${base}/collections/${layerId}/items/${row.id}`, type: "application/geo+json" },
      { rel: "parent", href: `${base}/collections/${layerId}`, type: "application/json" },
      { rel: "collection", href: `${base}/collections/${layerId}`, type: "application/json" },
      { rel: "root", href: base, type: "application/json" }
    ]
  }
}

/** SQL selecting promoted, non-empty snapshots of one layer. */
const SNAPSHOT_SQL = `
  SELECT s.id, s.observed_at, s.observed_end, s.created_at, s.metadata,
         ST_AsGeoJSON(s.footprint)::json AS geometry,
         ARRAY[ST_XMin(s.footprint), ST_YMin(s.footprint), ST_XMax(s.footprint), ST_YMax(s.footprint)] AS bbox,
         (SELECT count(*) FROM app.raster_sources WHERE snapshot_id = s.id)::int AS sources
  FROM app.raster_snapshots s
  JOIN app.raster_layers l ON l.id = s.layer_id AND l.session_id IS NULL
  WHERE s.layer_id = $1 AND s.status = 'promoted' AND s.footprint IS NOT NULL`

/**
 * One page of a collection's items, newest first, with a next link while
 * more remain. Null when the collection does not exist.
 */
export async function stacItems(
  pool: pg.Pool,
  base: string,
  apiBase: string,
  layerId: string,
  query: ItemQuery
): Promise<object | null> {
  const exists = await pool.query("SELECT 1 FROM app.raster_layers WHERE id = $1 AND session_id IS NULL", [layerId])
  if (exists.rows.length === 0) return null
  const params: unknown[] = [layerId]
  const where: string[] = []
  if (query.before) where.push(`s.observed_at < $${params.push(query.before)}`)
  if (query.datetime?.start) where.push(`coalesce(s.observed_end, s.observed_at) >= $${params.push(query.datetime.start)}`)
  if (query.datetime?.end) where.push(`s.observed_at <= $${params.push(query.datetime.end)}`)
  if (query.bbox) {
    where.push(`ST_Intersects(s.footprint, ST_MakeEnvelope($${params.push(query.bbox[0])}, $${params.push(query.bbox[1])}, $${params.push(query.bbox[2])}, $${params.push(query.bbox[3])}, 4326))`)
  }
  const result = await pool.query(
    `${SNAPSHOT_SQL}${where.map(w => ` AND ${w}`).join("")} ORDER BY s.observed_at DESC LIMIT $${params.push(query.limit + 1)}`,
    params
  )
  const rows = result.rows.slice(0, query.limit) as SnapshotRow[]
  const self = `${base}/collections/${layerId}/items`
  const links: Link[] = [
    { rel: "self", href: self, type: "application/geo+json" },
    { rel: "collection", href: `${base}/collections/${layerId}`, type: "application/json" },
    { rel: "root", href: base, type: "application/json" }
  ]
  if (result.rows.length > query.limit) {
    const next = new URLSearchParams({ limit: String(query.limit), token: rows[rows.length - 1].observed_at.toISOString() })
    if (query.datetime) next.set("datetime", `${query.datetime.start ?? ".."}/${query.datetime.end ?? ".."}`)
    if (query.bbox) next.set("bbox", query.bbox.join(","))
    links.push({ rel: "next", href: `${self}?${next}`, type: "application/geo+json" })
  }
  return {
    type: "FeatureCollection",
    features: rows.map(row => item(layerId, row, base, apiBase)),
    numberReturned: rows.length,
    links
  }
}

/** One item, or null when the collection or snapshot does not exist. */
export async function stacItem(pool: pg.Pool, base: string, apiBase: string, layerId: string, itemId: string): Promise<object | null> {
  const result = await pool.query(`${SNAPSHOT_SQL} AND s.id = $2`, [layerId, itemId])
  return result.rows.length === 0 ? null : item(layerId, result.rows[0], base, apiBase)
}

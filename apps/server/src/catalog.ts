import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { RasterArtifact, RasterLayerDestination, RasterSource } from "@data-integrator/definitions"
import { RasterStore } from "./rasterStore.js"

const execFileP = promisify(execFile)

/** Footprint, CRS and cell size of a raster file, derived or declared. */
interface RasterInfo {
  /** GeoJSON Polygon geometry in EPSG:4326 */
  footprint: object
  /** CRS identifier, e.g. "EPSG:4326" */
  crs: string
  /** Approximate cell width in metres; null when the file has no geotransform */
  cellSizeM: number | null
}

/** Metres per degree at the equator, for lon/lat grids. */
const METRES_PER_DEGREE = 111320

/** The shape gdalinfo -json returns, as far as registration reads it. */
interface GdalInfo {
  /** [originX, pixelWidth, 0, originY, 0, -pixelHeight] */
  geoTransform?: number[]
  /** Footprint in lon/lat, when georeferenced */
  wgs84Extent?: object
  /** Coordinate system as WKT */
  coordinateSystem?: { wkt?: string }
}

/**
 * Cell width in metres from a file's geotransform: degrees converted at the
 * equator for a geographic CRS, the CRS units (taken as metres) otherwise.
 */
export function cellSizeFromInfo(info: GdalInfo): number | null {
  const width = info.geoTransform?.[1]
  if (width === undefined) return null
  const geographic = /^GEOG(CRS|CS)\[/.test(info.coordinateSystem?.wkt ?? "")
  return Math.abs(width) * (geographic ? METRES_PER_DEGREE : 1)
}

/** [west, south, east, north] in EPSG:4326. */
type Bbox = [number, number, number, number]

/** Converts a bbox to a GeoJSON Polygon. */
function bboxPolygon(bbox: Bbox): object {
  const [w, s, e, n] = bbox
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
}

/** Envelope of a GeoJSON Polygon (any ring shape, as gdalinfo's wgs84Extent may be). */
function polygonBbox(polygon: object): Bbox {
  const ring = (polygon as { coordinates: number[][][] }).coordinates[0]
  const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of ring) {
    bbox[0] = Math.min(bbox[0], x)
    bbox[1] = Math.min(bbox[1], y)
    bbox[2] = Math.max(bbox[2], x)
    bbox[3] = Math.max(bbox[3], y)
  }
  return bbox
}

/** Reads a file's description via gdalinfo. */
async function gdalInfo(file: string): Promise<GdalInfo> {
  const { stdout } = await execFileP("gdalinfo", ["-json", file], { maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout) as GdalInfo
}

/**
 * Footprint and CRS as declared, else read from the file; cell size always
 * from the file, since nothing declares it.
 */
async function rasterInfo(file: string, declared: string, footprint?: Bbox, crs?: string): Promise<RasterInfo> {
  const info = await gdalInfo(file)
  const cellSizeM = cellSizeFromInfo(info)
  if (footprint && crs) return { footprint: bboxPolygon(footprint), crs, cellSizeM }
  const polygon = footprint ? bboxPolygon(footprint) : info.wgs84Extent
  if (!polygon) throw new Error(`No footprint for ${declared}: not georeferenced and none declared`)
  const wkt: string = info.coordinateSystem?.wkt ?? ""
  const epsg = wkt.match(/ID\["EPSG",(\d+)\]\]\s*$/) ?? wkt.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/)
  return { footprint: polygon, crs: crs ?? (epsg ? `EPSG:${epsg[1]}` : "unknown"), cellSizeM }
}

/** Ensures the raster_layers row for a destination exists and is owned by this integration. */
export async function ensureLayer(
  client: pg.ClientBase,
  integrationId: string,
  spec: RasterLayerDestination
): Promise<void> {
  const existing = await client.query("SELECT integration_id FROM app.raster_layers WHERE id = $1", [spec.layerId])
  const retentionDays = spec.retention?.days ?? null
  if (existing.rows.length === 0) {
    await client.query(
      `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands, retention_days)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        spec.layerId,
        integrationId,
        JSON.stringify(spec.name ?? { _base: "en", en: spec.layerId }),
        spec.temporality,
        JSON.stringify(spec.bands),
        retentionDays
      ]
    )
    return
  }
  if (existing.rows[0].integration_id !== integrationId) {
    throw new Error(`Layer ${spec.layerId} is owned by ${existing.rows[0].integration_id}`)
  }
  await client.query(
    "UPDATE app.raster_layers SET name = $2, temporality = $3, bands = $4, retention_days = $5 WHERE id = $1",
    [
      spec.layerId,
      JSON.stringify(spec.name ?? { _base: "en", en: spec.layerId }),
      spec.temporality,
      JSON.stringify(spec.bands),
      retentionDays
    ]
  )
}

/**
 * Resolves a path declared by a job (raster or table file) against the job's
 * out directory. Accepts the absolute container spelling (/out/x.tif) as well
 * as the contractual relative one; rejects anything escaping the directory.
 */
export function resolveArtifactPath(outDir: string, declared: string): string {
  const relative = declared.replace(/^\/out\//, "")
  const file = path.resolve(outDir, relative)
  if (!file.startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error(`Declared path escapes /out: ${declared}`)
  }
  return file
}

/**
 * Ensures the raster_layers row for a session's scratch preview of a declared
 * layer; owned by the session, invisible to the public layer list.
 */
export async function ensureScratchLayer(
  client: pg.ClientBase,
  sessionId: string,
  layerRowId: string,
  spec: RasterLayerDestination
): Promise<void> {
  await client.query(
    `INSERT INTO app.raster_layers (id, integration_id, session_id, name, temporality, bands)
     VALUES ($1, NULL, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, temporality = EXCLUDED.temporality, bands = EXCLUDED.bands`,
    [layerRowId, sessionId, JSON.stringify(spec.name ?? { _base: "en", en: spec.layerId }), spec.temporality, JSON.stringify(spec.bands)]
  )
}

/** One stored file of a snapshot, ready to register. */
export interface StoredSource {
  /** Position in the artifact's file list */
  ordinal: number
  /** Store-relative path */
  relPath: string
  /** GeoJSON Polygon footprint, EPSG:4326 */
  footprint: object
  /** File size */
  sizeBytes: number
}

/** A snapshot's files in the store plus what registration needs. */
export interface StoredSnapshot {
  /** Catalog id assigned to the snapshot */
  snapshotId: string
  /** Stored files in ordinal order; empty for an empty snapshot */
  sources: StoredSource[]
  /** Envelope of all sources as a GeoJSON Polygon; null when empty */
  footprint: object | null
  /** CRS shared by the sources */
  crs: string
  /** Band ids in file band order */
  bandIds: string[]
  /** Total bytes across sources */
  sizeBytes: number
  /** Approximate cell width in metres, from the first file; null when empty */
  cellSizeM: number | null
}

/**
 * The artifact's files as declared: `path` is one file, `sources` is a list
 * (possibly empty). Declaring both, or neither, is a contract error.
 */
function declaredSources(artifact: RasterArtifact): RasterSource[] {
  if (artifact.path !== undefined && artifact.sources !== undefined) {
    throw new Error(`Raster for ${artifact.layerId} declares both path and sources; use one`)
  }
  if (artifact.path !== undefined) return [{ path: artifact.path, footprint: artifact.footprint }]
  if (artifact.sources !== undefined) return artifact.sources
  throw new Error(`Raster for ${artifact.layerId} declares neither path nor sources`)
}

/**
 * Stores a snapshot's files (before the commit transaction; failures leave
 * only GC-able orphans) and returns the values needed to register it.
 * layerRowId is the raster_layers row the snapshot belongs to: the declared
 * layerId for real runs, the session's scratch layer id for design runs.
 */
export async function storeArtifact(
  store: RasterStore,
  outDir: string,
  artifact: RasterArtifact,
  bandIds: string[],
  layerRowId: string = artifact.layerId
): Promise<StoredSnapshot> {
  const snapshotId = randomUUID()
  const sources: StoredSource[] = []
  let crs: string | null = artifact.crs ?? null
  let cellSizeM: number | null = null
  for (const [ordinal, source] of declaredSources(artifact).entries()) {
    const file = resolveArtifactPath(outDir, source.path)
    const stats = await stat(file).catch(() => null)
    if (!stats?.isFile()) {
      const listing = await readdir(outDir, { recursive: true }).catch(() => [] as string[])
      throw new Error(
        `Declared raster "${source.path}" not found in /out. ` +
          `/out contains: ${listing.length > 0 ? listing.join(", ") : "(nothing)"}. ` +
          `Write the file to /out and declare its path relative to /out.`
      )
    }
    const info = await rasterInfo(file, source.path, source.footprint, crs ?? undefined)
    if (crs !== null && info.crs !== crs) {
      throw new Error(`Raster "${source.path}" is ${info.crs}; the snapshot's other files are ${crs}`)
    }
    crs = info.crs
    cellSizeM ??= info.cellSizeM
    const relPath = `${layerRowId}/${snapshotId}/${ordinal}.tif`
    await store.put(file, relPath)
    sources.push({ ordinal, relPath, footprint: info.footprint, sizeBytes: stats.size })
  }
  const bboxes = sources.map(s => polygonBbox(s.footprint))
  const footprint =
    bboxes.length === 0
      ? null
      : bboxPolygon([
          Math.min(...bboxes.map(b => b[0])),
          Math.min(...bboxes.map(b => b[1])),
          Math.max(...bboxes.map(b => b[2])),
          Math.max(...bboxes.map(b => b[3]))
        ])
  return {
    snapshotId,
    sources,
    footprint,
    crs: crs ?? "unknown",
    bandIds,
    sizeBytes: sources.reduce((sum, s) => sum + s.sizeBytes, 0),
    cellSizeM
  }
}

/**
 * Registers a stored snapshot as promoted inside the caller's commit
 * transaction: inserts the snapshot and its sources, supersedes the old
 * snapshot for current-only layers, and advances the layer's current pointer
 * when this snapshot is the newest promoted one. An empty snapshot goes
 * through the same steps: it is the observation that nothing was there.
 */
export async function registerSnapshot(
  client: pg.ClientBase,
  runId: string,
  artifact: RasterArtifact,
  stored: StoredSnapshot,
  temporality: "time-series" | "current-only",
  layerRowId: string = artifact.layerId
): Promise<void> {
  await client.query(
    `INSERT INTO app.raster_snapshots
       (id, layer_id, observed_at, observed_end, footprint, crs, bands, run_id, status, size_bytes, cell_size_m, metadata)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6, $7, $8, 'promoted', $9, $10, $11)`,
    [
      stored.snapshotId,
      layerRowId,
      artifact.timestamp,
      artifact.timestampEnd ?? null,
      stored.footprint === null ? null : JSON.stringify(stored.footprint),
      stored.crs,
      JSON.stringify(stored.bandIds),
      runId,
      stored.sizeBytes,
      stored.cellSizeM,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null
    ]
  )
  for (const source of stored.sources) {
    await client.query(
      `INSERT INTO app.raster_sources (snapshot_id, ordinal, path, footprint, size_bytes)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5)`,
      [stored.snapshotId, source.ordinal, source.relPath, JSON.stringify(source.footprint), source.sizeBytes]
    )
  }
  if (temporality === "current-only") {
    await client.query(
      `UPDATE app.raster_snapshots SET status = 'superseded'
       WHERE layer_id = $1 AND status = 'promoted' AND id <> $2`,
      [layerRowId, stored.snapshotId]
    )
  } else {
    // One promoted snapshot per observation time: re-ingesting a date
    // (revised source data, a source switch) replaces rather than duplicates
    await client.query(
      `UPDATE app.raster_snapshots SET status = 'superseded'
       WHERE layer_id = $1 AND status = 'promoted' AND id <> $2
         AND observed_at = $3 AND observed_end IS NOT DISTINCT FROM $4`,
      [layerRowId, stored.snapshotId, artifact.timestamp, artifact.timestampEnd ?? null]
    )
  }
  await advanceCurrentPointers(client, layerRowId)
}

/**
 * Which promoted snapshot a layer means by "current": the newest one whose
 * observation time has arrived, so a layer holding projections (annual
 * population to 2030) reads as this year's, not the furthest one. A layer with
 * only future snapshots takes the nearest.
 */
const CURRENT_SNAPSHOT_SORT = `
  (observed_at <= now()) DESC,
  CASE WHEN observed_at <= now() THEN observed_at END DESC,
  observed_at ASC, created_at DESC`

/**
 * Points every layer (or one layer) at its current snapshot. Runs at
 * promotion and on a scheduler tick, so a projection layer rolls over to the
 * next year without a run. Layers with no promoted snapshot are left alone.
 */
export async function advanceCurrentPointers(client: pg.ClientBase | pg.Pool, layerRowId?: string): Promise<number> {
  const result = await client.query(
    `UPDATE app.raster_layers l SET current_snapshot_id = c.id
     FROM (
       SELECT DISTINCT ON (layer_id) layer_id, id FROM app.raster_snapshots
       WHERE status = 'promoted' AND ($1::text IS NULL OR layer_id = $1)
       ORDER BY layer_id, ${CURRENT_SNAPSHOT_SORT}
     ) c
     WHERE c.layer_id = l.id AND l.current_snapshot_id IS DISTINCT FROM c.id`,
    [layerRowId ?? null]
  )
  return result.rowCount ?? 0
}

/** Store-relative paths and footprint envelopes of a snapshot's files, in ordinal order. */
export async function snapshotSources(client: pg.ClientBase | pg.Pool, snapshotId: string): Promise<SourceRef[]> {
  const result = await client.query(
    `SELECT path, ST_XMin(footprint) AS w, ST_YMin(footprint) AS s, ST_XMax(footprint) AS e, ST_YMax(footprint) AS n
     FROM app.raster_sources WHERE snapshot_id = $1 ORDER BY ordinal`,
    [snapshotId]
  )
  return result.rows.map(r => ({ path: r.path, bbox: [Number(r.w), Number(r.s), Number(r.e), Number(r.n)] }))
}

/** One file of a snapshot as readers need it. */
export interface SourceRef {
  /** Store-relative path */
  path: string
  /** [west, south, east, north] envelope, EPSG:4326 */
  bbox: Bbox
}

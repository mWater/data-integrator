import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { RasterArtifact, RasterLayerDestination } from "@data-integrator/definitions"
import { RasterStore } from "./rasterStore.js"

const execFileP = promisify(execFile)

/** Footprint and CRS of a raster file, derived or artifact-declared. */
interface RasterInfo {
  /** GeoJSON Polygon geometry in EPSG:4326 */
  footprint: object
  /** CRS identifier, e.g. "EPSG:4326" */
  crs: string
}

/** Converts an artifact bbox to a GeoJSON Polygon. */
function bboxPolygon(bbox: [number, number, number, number]): object {
  const [w, s, e, n] = bbox
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
}

/** Reads footprint and CRS from the file via gdalinfo when the artifact omits them. */
async function rasterInfo(file: string, artifact: RasterArtifact): Promise<RasterInfo> {
  if (artifact.footprint && artifact.crs) {
    return { footprint: bboxPolygon(artifact.footprint), crs: artifact.crs }
  }
  const { stdout } = await execFileP("gdalinfo", ["-json", file], { maxBuffer: 16 * 1024 * 1024 })
  const info = JSON.parse(stdout)
  const footprint = artifact.footprint ? bboxPolygon(artifact.footprint) : info.wgs84Extent
  if (!footprint) throw new Error(`No footprint for ${artifact.path}: not georeferenced and none declared`)
  const wkt: string = info.coordinateSystem?.wkt ?? ""
  const epsg = wkt.match(/ID\["EPSG",(\d+)\]\]\s*$/) ?? wkt.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/)
  const crs = artifact.crs ?? (epsg ? `EPSG:${epsg[1]}` : "unknown")
  return { footprint, crs }
}

/** Ensures the raster_layers row for a destination exists and is owned by this integration. */
export async function ensureLayer(
  client: pg.ClientBase,
  integrationId: string,
  spec: RasterLayerDestination
): Promise<void> {
  const existing = await client.query("SELECT integration_id FROM app.raster_layers WHERE id = $1", [spec.layerId])
  if (existing.rows.length === 0) {
    await client.query(
      `INSERT INTO app.raster_layers (id, integration_id, name, temporality, bands)
       VALUES ($1, $2, $3, $4, $5)`,
      [spec.layerId, integrationId, spec.name ?? spec.layerId, spec.temporality, JSON.stringify(spec.bands)]
    )
    return
  }
  if (existing.rows[0].integration_id !== integrationId) {
    throw new Error(`Layer ${spec.layerId} is owned by ${existing.rows[0].integration_id}`)
  }
  await client.query(
    "UPDATE app.raster_layers SET name = $2, temporality = $3, bands = $4 WHERE id = $1",
    [spec.layerId, spec.name ?? spec.layerId, spec.temporality, JSON.stringify(spec.bands)]
  )
}

/**
 * Resolves a declared artifact path against the job's out directory. Accepts
 * the absolute container spelling (/out/x.tif) as well as the contractual
 * relative one; rejects anything escaping the directory.
 */
export function resolveArtifactPath(outDir: string, declared: string): string {
  const relative = declared.replace(/^\/out\//, "")
  const file = path.resolve(outDir, relative)
  if (!file.startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error(`Declared raster path escapes /out: ${declared}`)
  }
  return file
}

/**
 * Stores one artifact file (before the commit transaction; failures leave only
 * GC-able orphans) and returns the values needed to register it.
 */
export async function storeArtifact(
  store: RasterStore,
  outDir: string,
  artifact: RasterArtifact,
  bandIds: string[]
): Promise<{ snapshotId: string; relPath: string; info: RasterInfo; bandIds: string[] }> {
  const file = resolveArtifactPath(outDir, artifact.path)
  const present = await stat(file).then(s => s.isFile(), () => false)
  if (!present) {
    const listing = await readdir(outDir, { recursive: true }).catch(() => [] as string[])
    throw new Error(
      `Declared raster "${artifact.path}" not found in /out. ` +
        `/out contains: ${listing.length > 0 ? listing.join(", ") : "(nothing)"}. ` +
        `Write the file to /out and declare its path relative to /out.`
    )
  }
  const info = await rasterInfo(file, artifact)
  const snapshotId = randomUUID()
  const relPath = `${artifact.layerId}/${snapshotId}.tif`
  await store.put(file, relPath)
  return { snapshotId, relPath, info, bandIds }
}

/**
 * Registers a stored artifact as a promoted snapshot inside the caller's commit
 * transaction: inserts the row, supersedes the old snapshot for current-only
 * layers, and advances the layer's current pointer when this snapshot is the
 * newest promoted one.
 */
export async function registerSnapshot(
  client: pg.ClientBase,
  runId: string,
  artifact: RasterArtifact,
  stored: { snapshotId: string; relPath: string; info: RasterInfo; bandIds: string[] },
  temporality: "time-series" | "current-only"
): Promise<void> {
  await client.query(
    `INSERT INTO app.raster_snapshots
       (id, layer_id, observed_at, observed_end, footprint, crs, path, bands, run_id, status)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6, $7, $8, $9, 'promoted')`,
    [
      stored.snapshotId,
      artifact.layerId,
      artifact.timestamp,
      artifact.timestampEnd ?? null,
      JSON.stringify(stored.info.footprint),
      stored.info.crs,
      stored.relPath,
      JSON.stringify(stored.bandIds),
      runId
    ]
  )
  if (temporality === "current-only") {
    await client.query(
      `UPDATE app.raster_snapshots SET status = 'superseded'
       WHERE layer_id = $1 AND status = 'promoted' AND id <> $2`,
      [artifact.layerId, stored.snapshotId]
    )
  }
  await client.query(
    `UPDATE app.raster_layers SET current_snapshot_id = (
       SELECT id FROM app.raster_snapshots
       WHERE layer_id = $1 AND status = 'promoted'
       ORDER BY observed_at DESC, created_at DESC LIMIT 1
     ) WHERE id = $1`,
    [artifact.layerId]
  )
}

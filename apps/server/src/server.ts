import { createServer, Server, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { BandSpec } from "@data-integrator/definitions"
import { TileRenderer } from "./tiles.js"

/** Static assets directory (demo map page). */
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static")

/** Matches /tiles/:layerId/:snapshotId/:z/:x/:y.png */
const TILE_PATH = /^\/tiles\/([a-z][a-z0-9_]*)\/([0-9a-f-]+)\/(\d+)\/(\d+)\/(\d+)\.png$/

/**
 * The HTTP API. Currently the demo sliver: layer discovery, snapshot-pinned
 * tiles, and the map page. Auth arrives with the full API.
 */
export function createApiServer(pool: pg.Pool, tiles: TileRenderer): Server {
  return createServer(async (req, res) => {
    try {
      await route(pool, tiles, req, res)
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })
}

/** Dispatches one request. */
async function route(pool: pg.Pool, tiles: TileRenderer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/"

  if (url === "/layers") {
    const result = await pool.query(
      `SELECT l.id, l.name, l.temporality, l.bands, l.current_snapshot_id,
              s.observed_at, s.observed_end, s.crs,
              ST_AsGeoJSON(ST_Envelope(s.footprint))::json AS footprint
       FROM app.raster_layers l
       LEFT JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       ORDER BY l.id`
    )
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ layers: result.rows }))
    return
  }

  const tileMatch = url.match(TILE_PATH)
  if (tileMatch) {
    const [, layerId, snapshotId, z, x, y] = tileMatch
    const snapshot = await pool.query(
      `SELECT s.path, l.bands FROM app.raster_snapshots s
       JOIN app.raster_layers l ON l.id = s.layer_id
       WHERE s.id = $1 AND s.layer_id = $2 AND s.status <> 'pending'`,
      [snapshotId, layerId]
    )
    if (snapshot.rows.length === 0) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unknown snapshot" }))
      return
    }
    const bands = snapshot.rows[0].bands as BandSpec[]
    const rendering = bands[0]?.rendering ?? {}
    const png = await tiles.tile(layerId, snapshotId, snapshot.rows[0].path, rendering, Number(z), Number(x), Number(y))
    // Snapshot-pinned URL: content never changes, cache hard
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" })
    res.end(png)
    return
  }

  if (url === "/" || url === "/map") {
    const html = await readFile(path.join(STATIC_DIR, "map.html"))
    res.writeHead(200, { "content-type": "text/html" })
    res.end(html)
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
}

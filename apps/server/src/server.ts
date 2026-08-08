import { createServer, Server, IncomingMessage, ServerResponse } from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { BandSpec } from "@data-integrator/definitions"
import { TileRenderer } from "./tiles.js"
import { AgentService } from "./agent/service.js"

/** Static assets directory (demo map page). */
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static")

/** Built UI directory served as the SPA (overridable for dev layouts). */
const UI_DIST = process.env.UI_DIST_PATH ?? path.join(STATIC_DIR, "..", "..", "ui", "dist")

/** Matches /tiles/:layerId/:snapshotId/:z/:x/:y.png */
const TILE_PATH = /^\/tiles\/([a-z][a-z0-9_]*)\/([0-9a-f-]+)\/(\d+)\/(\d+)\/(\d+)\.png$/

/** Matches /api/sessions/:id and captures the trailing subresource. */
const SESSION_PATH = /^\/api\/sessions\/([0-9a-f-]+)(\/messages|\/events)?$/

/** Content types for served static files. */
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2"
}

/** SSE heartbeat interval keeping idle connections open through proxies. */
const SSE_HEARTBEAT_MS = 25_000

/**
 * The HTTP API: layer discovery, snapshot-pinned tiles, designer session API
 * with SSE event streams, and the built SPA. Auth arrives with its own phase.
 * @param agent - Session service; null when no model is configured
 */
export function createApiServer(pool: pg.Pool, tiles: TileRenderer, agent: AgentService | null = null): Server {
  return createServer(async (req, res) => {
    try {
      await route(pool, tiles, agent, req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })
}

/** Sends a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Reads and parses a JSON request body (capped at 1 MB). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ""
  for await (const chunk of req) {
    data += chunk
    if (data.length > 1024 * 1024) throw new Error("Request body too large")
  }
  return data ? JSON.parse(data) : {}
}

/** Dispatches one request. */
async function route(
  pool: pg.Pool,
  tiles: TileRenderer,
  agent: AgentService | null,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/"

  if (url === "/layers") {
    const result = await pool.query(
      `SELECT l.id, l.name, l.temporality, l.bands, l.current_snapshot_id,
              s.observed_at, s.observed_end, s.crs,
              ST_AsGeoJSON(ST_Envelope(s.footprint))::json AS footprint,
              COALESCE(sn.snapshots, '[]'::json) AS snapshots
       FROM app.raster_layers l
       LEFT JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', id, 'observed_at', observed_at, 'observed_end', observed_end
                ) ORDER BY observed_at) AS snapshots
         FROM app.raster_snapshots WHERE layer_id = l.id AND status = 'promoted'
       ) sn ON true
       ORDER BY l.id`
    )
    json(res, 200, { layers: result.rows })
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
      json(res, 404, { error: "unknown snapshot" })
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

  if (url.startsWith("/api/sessions")) {
    await routeSessions(agent, req, res, url)
    return
  }

  if (url === "/map") {
    const html = await readFile(path.join(STATIC_DIR, "map.html"))
    res.writeHead(200, { "content-type": "text/html" })
    res.end(html)
    return
  }

  if (req.method === "GET" && (await serveUi(url, res))) return

  json(res, 404, { error: "not found" })
}

/** Handles the /api/sessions routes. */
async function routeSessions(
  agent: AgentService | null,
  req: IncomingMessage,
  res: ServerResponse,
  url: string
): Promise<void> {
  if (!agent) {
    json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
    return
  }

  if (url === "/api/sessions") {
    if (req.method === "POST") {
      const body = await readJsonBody(req)
      const sessionId = await agent.createSession(String(body.integrationId ?? ""))
      json(res, 201, { sessionId })
    } else {
      json(res, 200, { sessions: await agent.listSessions() })
    }
    return
  }

  const match = url.match(SESSION_PATH)
  if (!match) {
    json(res, 404, { error: "not found" })
    return
  }
  const [, sessionId, sub] = match

  if (!sub && req.method === "GET") {
    const detail = await agent.getSession(sessionId)
    if (!detail) json(res, 404, { error: "unknown session" })
    else json(res, 200, detail)
    return
  }

  if (sub === "/messages" && req.method === "POST") {
    const body = await readJsonBody(req)
    const text = String(body.text ?? "").trim()
    if (!text) {
      json(res, 400, { error: "text is required" })
      return
    }
    try {
      await agent.send(sessionId, text)
      json(res, 202, { accepted: true })
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (sub === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    })
    res.write(": connected\n\n")
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS)
    const unsubscribe = agent.subscribe(sessionId, event => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    req.on("close", () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    return
  }

  json(res, 404, { error: "not found" })
}

/** Serves the built SPA; returns false when the file tree has no answer. */
async function serveUi(url: string, res: ServerResponse): Promise<boolean> {
  const requested = url === "/" ? "/index.html" : url.split("?")[0]
  const file = path.normalize(path.join(UI_DIST, requested))
  if (!file.startsWith(path.normalize(UI_DIST))) return false

  const target = await stat(file).then(s => (s.isFile() ? file : null)).catch(() => null)
  // SPA fallback: unknown paths get index.html (hash routing makes this rare)
  const resolved = target ?? (path.extname(requested) === "" ? path.join(UI_DIST, "index.html") : null)
  if (!resolved) return false

  try {
    const content = await readFile(resolved)
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream" })
    res.end(content)
    return true
  } catch {
    return false
  }
}

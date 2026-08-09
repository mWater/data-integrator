import { createServer, Server, IncomingMessage, ServerResponse } from "node:http"
import { BasemapProxy } from "./basemap.js"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { BandSpec } from "@data-integrator/definitions"
import { TileRenderer } from "./tiles.js"
import { AgentService } from "./agent/service.js"
import { getIntegration, getTableRows, listIntegrations } from "./integrations.js"
import { listSources } from "./sources.js"
import { RunService } from "./runService.js"
import { RasterStore } from "./rasterStore.js"
import { listTables, parseRowsQuery, queryRows, rowsToCsv, rowsToGeoJson } from "./queryApi.js"
import {
  canViewDashboard,
  executeDashboardQuery,
  getDashboard,
  listDashboards,
  saveDashboard
} from "./dashboards/service.js"
import { DashboardQuery, executeStoredQuery } from "./dashboards/queries.js"
import {
  authenticate,
  AuthUser,
  createApiToken,
  createAuthSession,
  deleteAuthSession,
  getSessionUser,
  getTokenUser,
  listApiTokens,
  revokeApiToken
} from "./auth.js"

/** Static assets directory (demo map page). */
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static")

/** Kit runtime assets directory (@data-integrator/kit/assets). */
const KIT_ASSETS = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@data-integrator/kit")),
  "..",
  "assets"
)

/** Matches /kit/:version/:file — the public, immutable kit runtime assets. */
const KIT_PATH = /^\/kit\/[a-z0-9.-]+\/([a-z0-9][a-z0-9.-]*\.(?:js|mjs|cjs|css))$/

/** Built UI directory served as the SPA (overridable for dev layouts). */
const UI_DIST = process.env.UI_DIST_PATH ?? path.join(STATIC_DIR, "..", "..", "ui", "dist")

/** Matches /tiles/:layerId/:snapshotId/:z/:x/:y.png */
const TILE_PATH = /^\/tiles\/([a-z][a-z0-9_]*)\/([0-9a-f-]+)\/(\d+)\/(\d+)\/(\d+)\.png$/

/** Matches /api/sessions/:id and captures the trailing subresource. */
const SESSION_PATH = /^\/api\/sessions\/([0-9a-f-]+)(\/messages|\/events|\/stop|\/queries\/[a-z][a-z0-9_]*)?$/

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

/** Session cookie name. */
const COOKIE_NAME = "di_session"

/** Session cookie lifetime in seconds (mirrors the DB session expiry). */
const COOKIE_MAX_AGE = 30 * 24 * 3600

/**
 * The HTTP API: layer discovery, snapshot-pinned tiles, integrations browse
 * with manual runs and table previews, designer session API with SSE event
 * streams, and the built SPA.
 * @param agent - Session service; null when no model is configured
 * @param runs - Manual-run service; null when the host has no job runner
 */
export function createApiServer(
  pool: pg.Pool,
  tiles: TileRenderer,
  agent: AgentService | null = null,
  runs: RunService | null = null,
  store: RasterStore | null = null,
  dashboardAgent: AgentService | null = null,
  basemap: BasemapProxy | null = null
): Server {
  return createServer(async (req, res) => {
    try {
      await route(pool, tiles, agent, runs, store, dashboardAgent, basemap, req, res)
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

/** Reads the session token from the request cookies. */
function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=")
    if (key === COOKIE_NAME) return value.join("=")
  }
  return null
}

/** Set-Cookie value for a session token; null clears the cookie. */
function sessionCookie(token: string | null, req: IncomingMessage): string {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""
  const value = token ?? ""
  const maxAge = token ? COOKIE_MAX_AGE : 0
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

/** Dispatches one request. */
async function route(
  pool: pg.Pool,
  tiles: TileRenderer,
  agent: AgentService | null,
  runs: RunService | null,
  store: RasterStore | null,
  dashboardAgent: AgentService | null,
  basemap: BasemapProxy | null,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/"
  const [pathname, search] = url.split("?")
  const searchParams = new URLSearchParams(search ?? "")

  // Kit runtime assets are public open-source code; versioned URLs cache hard
  const kitMatch = pathname.match(KIT_PATH)
  if (kitMatch && req.method === "GET") {
    const file = path.join(KIT_ASSETS, kitMatch[1])
    try {
      await stat(file)
    } catch {
      json(res, 404, { error: "no such kit asset" })
      return
    }
    res.writeHead(200, {
      "content-type": kitMatch[1].endsWith(".css") ? "text/css" : "text/javascript",
      "cache-control": "public, max-age=31536000, immutable",
      // Module scripts fetch with CORS from the opaque-origin dashboard frame
      "access-control-allow-origin": "*"
    })
    createReadStream(file).pipe(res)
    return
  }

  // The API contract is public documentation (no data)
  if (pathname === "/api/openapi.json") {
    const spec = await readFile(path.join(STATIC_DIR, "openapi.json"))
    res.writeHead(200, { "content-type": "application/json" })
    res.end(spec)
    return
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req)
    const result = await authenticate(pool, String(body.email ?? ""), String(body.password ?? ""))
    if (!result.ok) {
      json(res, 401, { error: result.reason === "locked" ? "Account locked; try again later" : "Invalid email or password" })
      return
    }
    const token = await createAuthSession(pool, result.user.id)
    res.setHeader("set-cookie", sessionCookie(token, req))
    json(res, 200, { user: { email: result.user.email, role: result.user.role } })
    return
  }

  // Bearer tokens (programmatic API) take precedence over the session cookie
  const authHeader = req.headers.authorization
  let user: AuthUser | null = null
  if (authHeader?.startsWith("Bearer ")) {
    user = await getTokenUser(pool, authHeader.slice(7))
  }
  const token = cookieToken(req)
  if (!user && token) user = await getSessionUser(pool, token)

  if (pathname === "/api/logout" && req.method === "POST") {
    if (token) await deleteAuthSession(pool, token)
    res.setHeader("set-cookie", sessionCookie(null, req))
    json(res, 200, { ok: true })
    return
  }

  if (pathname === "/api/me") {
    if (!user) json(res, 401, { error: "not signed in" })
    else json(res, 200, { user: { email: user.email, role: user.role } })
    return
  }

  // Everything below is either the static shell (public) or data (auth required)
  if (!user) {
    if (req.method === "GET" && pathname === "/map") {
      const html = await readFile(path.join(STATIC_DIR, "map.html"))
      res.writeHead(200, { "content-type": "text/html" })
      res.end(html)
      return
    }
    if (req.method === "GET" && !pathname.startsWith("/api") && pathname !== "/layers" && !TILE_PATH.test(pathname)) {
      if (await serveUi(url, res)) return
    }
    json(res, 401, { error: "authentication required" })
    return
  }

  // Basemap proxy: cached upstream style/sprite/glyph/tile bytes for map frames
  const basemapMatch = pathname.match(/^\/basemap\/(.+)$/)
  if (basemapMatch && req.method === "GET") {
    let framePath: string
    try {
      framePath = decodeURIComponent(basemapMatch[1])
    } catch {
      json(res, 400, { error: "bad basemap path" })
      return
    }
    const result = basemap ? await basemap.fetch(framePath) : null
    if (!result) {
      json(res, 404, { error: "basemap unavailable" })
      return
    }
    res.writeHead(200, {
      "content-type": result.contentType,
      "cache-control": "public, max-age=86400"
    })
    res.end(result.body)
    return
  }

  if (pathname === "/api/tokens") {
    if (req.method === "POST") {
      const body = await readJsonBody(req)
      const name = String(body.name ?? "").trim()
      if (!name) {
        json(res, 400, { error: "name is required" })
        return
      }
      const expiresDays = body.expiresDays === undefined ? undefined : Number(body.expiresDays)
      const bearer = await createApiToken(pool, user.id, name, expiresDays)
      json(res, 201, { token: bearer, note: "Shown once; store it now" })
    } else {
      json(res, 200, { tokens: await listApiTokens(pool, user.id) })
    }
    return
  }

  const tokenMatch = pathname.match(/^\/api\/tokens\/([0-9a-f]{64})$/)
  if (tokenMatch && req.method === "DELETE") {
    if (await revokeApiToken(pool, user.id, tokenMatch[1])) json(res, 200, { ok: true })
    else json(res, 404, { error: "no such token" })
    return
  }

  if (pathname === "/api/tables") {
    json(res, 200, { tables: await listTables(pool) })
    return
  }

  const queryMatch = pathname.match(/^\/api\/tables\/([a-z][a-z0-9_]*)\/rows$/)
  if (queryMatch) {
    let result
    try {
      result = await queryRows(pool, queryMatch[1], parseRowsQuery(searchParams))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!result) {
      json(res, 404, { error: "unknown table" })
      return
    }
    const format = searchParams.get("format") ?? "json"
    if (format === "csv") {
      res.writeHead(200, { "content-type": "text/csv" })
      res.end(rowsToCsv(result))
    } else if (format === "geojson") {
      try {
        json(res, 200, rowsToGeoJson(result))
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
    } else {
      json(res, 200, { columns: result.columns, rows: result.rows })
    }
    return
  }

  const downloadMatch = pathname.match(/^\/api\/snapshots\/([0-9a-f-]+)\/download$/)
  if (downloadMatch && store) {
    const snapshot = await pool.query(
      "SELECT layer_id, path FROM app.raster_snapshots WHERE id = $1 AND status <> 'pending'",
      [downloadMatch[1]]
    )
    if (snapshot.rows.length === 0) {
      json(res, 404, { error: "unknown snapshot" })
      return
    }
    const { layer_id, path: relPath } = snapshot.rows[0]
    res.writeHead(200, {
      "content-type": "image/tiff",
      "content-disposition": `attachment; filename="${layer_id}_${downloadMatch[1]}.tif"`
    })
    createReadStream(store.absolute(relPath)).pipe(res)
    return
  }

  if (pathname === "/layers" || pathname === "/api/layers") {
    // Default: installed layers only. ?session=<id> instead lists that design
    // session's scratch preview layers.
    const session = searchParams.get("session")
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
       WHERE ${session ? "l.session_id = $1" : "l.session_id IS NULL"}
       ORDER BY l.id`,
      session ? [session] : []
    )
    json(res, 200, { layers: result.rows })
    return
  }

  const tileMatch = pathname.match(TILE_PATH)
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

  if (pathname === "/api/sources") {
    json(res, 200, { sources: await listSources(pool) })
    return
  }

  if (pathname === "/api/integrations") {
    json(res, 200, { integrations: await listIntegrations(pool) })
    return
  }

  const integrationMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)$/)
  if (integrationMatch) {
    const detail = await getIntegration(pool, integrationMatch[1])
    if (!detail) json(res, 404, { error: "unknown integration" })
    else json(res, 200, detail)
    return
  }

  const runMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/run$/)
  if (runMatch && req.method === "POST") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot start runs" })
      return
    }
    if (!runs) {
      json(res, 503, { error: "No job runner configured on this server" })
      return
    }
    try {
      json(res, 202, { runId: await runs.start(runMatch[1]) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      json(res, message.includes("already queued") ? 409 : message.includes("Unknown") ? 404 : 500, { error: message })
    }
    return
  }

  const rowsMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/tables\/([a-z][a-z0-9_]*)\/rows$/)
  if (rowsMatch) {
    const preview = await getTableRows(pool, rowsMatch[1], rowsMatch[2])
    if (!preview) json(res, 404, { error: "no such destination table (or no data yet)" })
    else json(res, 200, preview)
    return
  }

  if (pathname === "/api/dashboards") {
    if (req.method === "POST") {
      if (user.role === "viewer") {
        json(res, 403, { error: "Viewers cannot save dashboards" })
        return
      }
      const body = await readJsonBody(req)
      const result = await saveDashboard(pool, {
        id: String(body.id ?? ""),
        name: String(body.name ?? ""),
        source: String(body.source ?? ""),
        queries: (body.queries ?? []) as never
      })
      if (result.ok) json(res, 201, { version: result.version })
      else json(res, 400, { errors: result.errors })
    } else {
      json(res, 200, { dashboards: await listDashboards(pool) })
    }
    return
  }

  const dashboardMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)$/)
  if (dashboardMatch) {
    if (!canViewDashboard(user, dashboardMatch[1])) {
      json(res, 403, { error: "no access to this dashboard" })
      return
    }
    const detail = await getDashboard(pool, dashboardMatch[1])
    if (!detail) json(res, 404, { error: "unknown dashboard" })
    else json(res, 200, detail)
    return
  }

  const dashboardQueryMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/queries\/([a-z][a-z0-9_]*)$/)
  if (dashboardQueryMatch && req.method === "POST") {
    if (!canViewDashboard(user, dashboardQueryMatch[1])) {
      json(res, 403, { error: "no access to this dashboard" })
      return
    }
    const body = await readJsonBody(req)
    try {
      const rows = await executeDashboardQuery(
        pool,
        dashboardQueryMatch[1],
        dashboardQueryMatch[2],
        (body.params ?? {}) as Record<string, unknown>
      )
      if (rows === null) json(res, 404, { error: "unknown dashboard or query" })
      else json(res, 200, { rows })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (pathname.startsWith("/api/sessions")) {
    await routeSessions(pool, agent, dashboardAgent, user, req, res, url)
    return
  }

  if (pathname === "/map") {
    const html = await readFile(path.join(STATIC_DIR, "map.html"))
    res.writeHead(200, { "content-type": "text/html" })
    res.end(html)
    return
  }

  if (req.method === "GET" && (await serveUi(url, res))) return

  json(res, 404, { error: "not found" })
}

/** Handles the /api/sessions routes; design actions need editor or admin. */
async function routeSessions(
  pool: pg.Pool,
  agent: AgentService | null,
  dashboardAgent: AgentService | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  url: string
): Promise<void> {
  if (req.method === "POST" && user.role === "viewer") {
    json(res, 403, { error: "Viewers cannot run design sessions" })
    return
  }
  if (!agent && !dashboardAgent) {
    json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
    return
  }

  /** Service owning a stored session, resolved by its kind column. */
  const serviceFor = async (sessionId: string): Promise<AgentService | null> => {
    const row = await pool.query("SELECT kind FROM app.agent_sessions WHERE id = $1", [sessionId])
    if (row.rows.length === 0) return null
    return row.rows[0].kind === "dashboard" ? dashboardAgent : agent
  }

  if (url === "/api/sessions") {
    if (req.method === "POST") {
      const body = await readJsonBody(req)
      const kind = body.kind === "dashboard" ? "dashboard" : "designer"
      const service = kind === "dashboard" ? dashboardAgent : agent
      if (!service) {
        json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
        return
      }
      const bindId = kind === "dashboard" ? body.dashboardId : body.integrationId
      const sessionId = await service.createSession(bindId == null || bindId === "" ? undefined : String(bindId))
      json(res, 201, { sessionId })
    } else {
      const lists = await Promise.all([agent?.listSessions(), dashboardAgent?.listSessions()])
      const sessions = lists
        .flatMap(l => l ?? [])
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      json(res, 200, { sessions })
    }
    return
  }

  const match = url.match(SESSION_PATH)
  if (!match) {
    json(res, 404, { error: "not found" })
    return
  }
  const [, sessionId, sub] = match
  const owner = await serviceFor(sessionId)
  if (!owner) {
    json(res, 404, { error: "unknown session" })
    return
  }
  const agentService = owner

  if (!sub && req.method === "GET") {
    const detail = await agentService.getSession(sessionId)
    if (!detail) json(res, 404, { error: "unknown session" })
    else json(res, 200, detail)
    return
  }

  // Draft stored-query execution for the design-session preview
  const queryName = sub?.startsWith("/queries/") ? sub.slice("/queries/".length) : null
  if (queryName && req.method === "POST") {
    const detail = await agentService.getSession(sessionId)
    const state = detail?.state as { queries?: DashboardQuery[] } | undefined
    const query = state?.queries?.find(q => q.name === queryName)
    if (!query) {
      json(res, 404, { error: "unknown draft query" })
      return
    }
    const body = await readJsonBody(req)
    try {
      json(res, 200, { rows: await executeStoredQuery(pool, query, (body.params ?? {}) as Record<string, unknown>) })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
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
      await agentService.send(sessionId, text)
      json(res, 202, { accepted: true })
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (sub === "/stop" && req.method === "POST") {
    json(res, 202, { stopping: agentService.stop(sessionId) })
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
    const unsubscribe = agentService.subscribe(sessionId, event => {
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
    // Hashed assets cache forever; everything else (index.html) must revalidate,
    // or browsers heuristically cache it and keep loading stale bundles
    const immutable = resolved.includes(`${path.sep}assets${path.sep}`)
    res.writeHead(200, {
      "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache"
    })
    res.end(content)
    return true
  } catch {
    return false
  }
}

import { createServer, Server, IncomingMessage, ServerResponse } from "node:http"
import { BasemapProxy } from "./basemap.js"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { BandSpec, IntegrationDefinition } from "@data-integrator/definitions"
import { TileRenderer } from "./tiles.js"
import { AgentService } from "./agent/service.js"
import { getIntegration, getTableRows, listIntegrations, listIntegrationVersions } from "./integrations.js"
import { getWebhookToken, receiveWebhook, rotateWebhookToken, WEBHOOK_TOKEN_PATTERN } from "./webhooks.js"
import { deleteIntegration, installIntegration, integrationUsage } from "./install.js"
import { getHomeSummary } from "./home.js"
import { installLibraryEntry, listLibrary } from "./library.js"
import { parseCron } from "./cron.js"
import { loadSkill, loadSkillsIndex, skillsDir } from "./skills.js"
import { listSources, tableGeometry } from "./sources.js"
import { copySecret, deleteSecret, listAllSecrets, listSecrets, loadSecretKey, setSecret } from "./secrets.js"
import { RunService } from "./runService.js"
import { RasterStore } from "./rasterStore.js"
import { listTables, parseRowsQuery, queryRows, rowsToCsv, rowsToGeoJson } from "./queryApi.js"
import {
  canViewDashboard,
  deleteDashboard,
  executeDashboardQuery,
  executeDashboardTileQuery,
  getDashboard,
  listDashboards,
  saveDashboard
} from "./dashboards/service.js"
import { DashboardQuery, executeStoredQuery, executeTableTileQuery, executeTileQuery } from "./dashboards/queries.js"
import { COUNTRIES } from "./countries.js"
import {
  DEFAULT_AOI_KEY,
  getDefaultAoi,
  getSiteTitle,
  parseAoi,
  parseDefaultAoi,
  parseSiteTitle,
  setSetting,
  SITE_TITLE_KEY
} from "./settings.js"
import {
  authenticate,
  AuthUser,
  createApiToken,
  createAuthSession,
  deleteAuthSession,
  getSessionUser,
  getTokenUser,
  listApiTokens,
  revokeApiToken,
  setPassword,
  verifyPassword
} from "./auth.js"
import { createManagedUser, listUsers, resetPassword, setDisabled, setRole } from "./users.js"

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

/** Built UI directory served as the SPA (config.uiDistPath overrides for dev layouts). */
const DEFAULT_UI_DIST = path.join(STATIC_DIR, "..", "..", "ui", "dist")

/**
 * Matches /tiles/:layerId/:snapshotId/:z/:x/:y.png and its band-qualified form
 * /tiles/:layerId/:snapshotId/:bandId/:z/:x/:y.png. The band segment is
 * unambiguous because band ids must start with a letter and z never can.
 */
const TILE_PATH =
  /^\/tiles\/([a-z][a-z0-9_]*)\/([0-9a-f-]+)(?:\/([a-z][a-z0-9_]*))?\/(\d+)\/(\d+)\/(\d+)\.png$/

/** Matches /api/sessions/:id and captures the trailing subresource. */
const SESSION_PATH =
  /^\/api\/sessions\/([0-9a-f-]+)(\/messages|\/events|\/stop|\/queries\/[a-z][a-z0-9_]*|\/tiles\/[a-z][a-z0-9_]*\/\d+\/\d+\/\d+\.mvt)?$/

/** Matches /api/dashboards/:id/tiles/:name/:z/:x/:y.mvt (stored tile queries). */
const DASHBOARD_TILE_PATH =
  /^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/tiles\/([a-z][a-z0-9_]*)\/(\d+)\/(\d+)\/(\d+)\.mvt$/

/** Content type of encoded vector tiles. */
const MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"

/** Parses the ?params= JSON of a tile request; throws on malformed input. */
function tileParams(searchParams: URLSearchParams): Record<string, unknown> {
  const raw = searchParams.get("params")
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("params must be a JSON object")
  return parsed as Record<string, unknown>
}

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
  basemap: BasemapProxy | null = null,
  uiDistPath: string | null = null,
  libraryPath: string | null = null,
  assistantAgent: AgentService | null = null
): Server {
  const uiDist = uiDistPath ?? DEFAULT_UI_DIST
  return createServer(async (req, res) => {
    try {
      await route(pool, tiles, agent, runs, store, dashboardAgent, basemap, uiDist, libraryPath, assistantAgent, req, res)
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
  uiDist: string,
  libraryPath: string | null,
  assistantAgent: AgentService | null,
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

  // Webhook receiver: the random token in the URL is the credential, so no
  // session applies; unknown and non-webhook integrations 404 alike
  if (pathname.startsWith("/hooks/")) {
    if (req.method !== "POST") {
      json(res, 405, { error: "POST only" })
      return
    }
    const hookToken = pathname.slice("/hooks/".length)
    if (!WEBHOOK_TOKEN_PATTERN.test(hookToken)) {
      json(res, 404, { error: "unknown webhook" })
      return
    }
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
    if (contentType !== "application/json") {
      json(res, 415, { error: "application/json required" })
      return
    }
    let payload: unknown
    try {
      payload = await readJsonBody(req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      json(res, message === "Request body too large" ? 413 : 400, { error: message })
      return
    }
    const receipt = await receiveWebhook(pool, hookToken, payload)
    if (!receipt) json(res, 404, { error: "unknown webhook" })
    else json(res, 202, { eventId: receipt.eventId })
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
    if (req.method === "GET" && !pathname.startsWith("/api") && pathname !== "/layers" && !TILE_PATH.test(pathname)) {
      if (await serveUi(url, res, uiDist)) return
    }
    json(res, 401, { error: "authentication required" })
    return
  }

  // Baked-in country boxes for AOI pickers (Natural Earth derived)
  if (pathname === "/api/countries" && req.method === "GET") {
    json(res, 200, { countries: COUNTRIES })
    return
  }

  // Secrets: per-integration write-only credential store. Names and update
  // times are visible to editors and admins; values are set or replaced by
  // admins and never readable back through any interface.
  if (pathname === "/api/secrets" && req.method === "GET") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can view the deployment secret list" })
      return
    }
    json(res, 200, { secrets: await listAllSecrets(pool) })
    return
  }
  const intSecretsMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/secrets$/)
  if (intSecretsMatch && req.method === "GET") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Only editors can view secret names" })
      return
    }
    json(res, 200, { secrets: await listSecrets(pool, intSecretsMatch[1]) })
    return
  }
  const intSecretMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/secrets\/([a-z][a-z0-9_]{0,63})$/)
  if (intSecretMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const [, integrationId, name] = intSecretMatch
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can manage secrets" })
      return
    }
    if (!(await getIntegration(pool, integrationId))) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    if (req.method === "DELETE") {
      if (await deleteSecret(pool, integrationId, name)) json(res, 200, { deleted: name })
      else json(res, 404, { error: "no such secret" })
      return
    }
    let secretKey
    try {
      secretKey = loadSecretKey()
    } catch {
      json(res, 503, { error: "INTEGRATOR_SECRET_KEY is not configured on this deployment" })
      return
    }
    const body = await readJsonBody(req)
    if (typeof body.copyFrom === "string") {
      if (await copySecret(pool, secretKey, body.copyFrom, integrationId, name)) json(res, 200, { name })
      else json(res, 404, { error: "the source integration has no such secret" })
      return
    }
    const value = String(body.value ?? "")
    if (value.length === 0 || value.length > 65536) {
      json(res, 400, { error: "value must be 1 to 65536 characters" })
      return
    }
    await setSecret(pool, secretKey, integrationId, name, value)
    json(res, 200, { name })
    return
  }

  // Deployment settings: readable by any signed-in user, writable by admins
  if (pathname === "/api/settings" && req.method === "GET") {
    json(res, 200, {
      settings: { default_aoi: await getDefaultAoi(pool), site_title: await getSiteTitle(pool) }
    })
    return
  }
  if (pathname === `/api/settings/${SITE_TITLE_KEY}` && req.method === "PUT") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change settings" })
      return
    }
    let title
    try {
      title = parseSiteTitle(await readJsonBody(req))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    await setSetting(pool, SITE_TITLE_KEY, title)
    json(res, 200, { site_title: title })
    return
  }
  if (pathname === `/api/settings/${DEFAULT_AOI_KEY}` && (req.method === "PUT" || req.method === "DELETE")) {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change settings" })
      return
    }
    if (req.method === "DELETE") {
      await setSetting(pool, DEFAULT_AOI_KEY, null)
      json(res, 200, { default_aoi: null })
      return
    }
    let aoi
    try {
      aoi = parseDefaultAoi(await readJsonBody(req))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    await setSetting(pool, DEFAULT_AOI_KEY, aoi)
    json(res, 200, { default_aoi: aoi })
    return
  }

  // Own password change: any signed-in user, proving the current password
  if (pathname === "/api/me/password" && req.method === "POST") {
    const body = await readJsonBody(req)
    const newPassword = String(body.newPassword ?? "")
    if (newPassword.length < 8) {
      json(res, 400, { error: "Password must be at least 8 characters" })
      return
    }
    const row = await pool.query("SELECT password_hash FROM app.users WHERE id = $1", [user.id])
    // A wrong guess here does not feed the login lockout counter: the caller
    // already holds a valid session, and a stale tab must not lock the account
    if (row.rows.length === 0 || !(await verifyPassword(row.rows[0].password_hash, String(body.currentPassword ?? "")))) {
      json(res, 400, { error: "Current password is incorrect" })
      return
    }
    await setPassword(pool, user.email, newPassword)
    json(res, 200, { ok: true })
    return
  }

  // User management: list/add, and per-user reset/role/disable — admins only
  const userActionMatch = pathname.match(/^\/api\/users\/([0-9a-f-]{36})\/(password|role|disabled)$/)
  if (pathname === "/api/users" || userActionMatch) {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can manage users" })
      return
    }
    if (pathname === "/api/users") {
      if (req.method === "POST") {
        const body = await readJsonBody(req)
        const email = String(body.email ?? "").trim()
        const role = String(body.role ?? "")
        if (!email.includes("@")) {
          json(res, 400, { error: "A valid email is required" })
          return
        }
        if (!["admin", "editor", "viewer"].includes(role)) {
          json(res, 400, { error: "Role must be admin, editor, or viewer" })
          return
        }
        try {
          json(res, 201, await createManagedUser(pool, email, role as AuthUser["role"]))
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            json(res, 409, { error: "A user with that email already exists" })
          } else throw err
        }
      } else {
        json(res, 200, { users: await listUsers(pool) })
      }
      return
    }
    const [, targetId, action] = userActionMatch!
    if (action === "password" && req.method === "POST") {
      const password = await resetPassword(pool, targetId)
      if (password === null) json(res, 404, { error: "no such user" })
      else json(res, 200, { password })
      return
    }
    if (action === "role" && req.method === "PUT") {
      const body = await readJsonBody(req)
      const role = String(body.role ?? "")
      if (!["admin", "editor", "viewer"].includes(role)) {
        json(res, 400, { error: "Role must be admin, editor, or viewer" })
        return
      }
      const result = await setRole(pool, targetId, role as AuthUser["role"])
      if (result.ok) json(res, 200, { user: result.user })
      else if (result.reason === "not-found") json(res, 404, { error: "no such user" })
      else json(res, 409, { error: "Cannot demote the last active admin" })
      return
    }
    if (action === "disabled" && req.method === "PUT") {
      const body = await readJsonBody(req)
      const disabled = Boolean(body.disabled)
      if (disabled && targetId === user.id) {
        json(res, 400, { error: "You cannot disable your own account" })
        return
      }
      const result = await setDisabled(pool, targetId, disabled)
      if (result.ok) json(res, 200, { user: result.user })
      else if (result.reason === "not-found") json(res, 404, { error: "no such user" })
      else json(res, 409, { error: "Cannot disable the last active admin" })
      return
    }
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

  // Map view of a destination table: geometry facts, then MVT vector tiles
  const tableGeomMatch = pathname.match(/^\/api\/tables\/([a-z][a-z0-9_]*)\/geometry$/)
  if (tableGeomMatch && req.method === "GET") {
    const geometry = await tableGeometry(pool, tableGeomMatch[1])
    if (!geometry) json(res, 404, { error: "unknown table" })
    else json(res, 200, geometry)
    return
  }
  const tableTileMatch = pathname.match(/^\/api\/tables\/([a-z][a-z0-9_]*)\/tiles\/(\d+)\/(\d+)\/(\d+)\.mvt$/)
  if (tableTileMatch && req.method === "GET") {
    const [, tableId, z, x, y] = tableTileMatch
    const geometry = await tableGeometry(pool, tableId)
    if (!geometry?.geometryColumn) {
      json(res, 404, { error: "no geometry to map" })
      return
    }
    try {
      const mvt = await executeTableTileQuery(pool, tableId, geometry.geometryColumn, Number(z), Number(x), Number(y))
      res.writeHead(200, { "content-type": MVT_CONTENT_TYPE, "cache-control": "private, max-age=60" })
      res.end(mvt)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
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

  // One layer in full, for its detail page. ?session= scopes to a design
  // session's scratch layers, matching /layers.
  const layerMatch = pathname.match(/^\/api\/layers\/([a-z][a-z0-9_]*)$/)
  if (layerMatch && req.method === "GET") {
    const session = searchParams.get("session")
    const result = await pool.query(
      `SELECT l.id, l.name, l.temporality, l.bands, l.current_snapshot_id,
              l.integration_id, i.definition->>'name' AS integration_name,
              s.observed_at, s.observed_end, s.crs,
              ST_AsGeoJSON(ST_Envelope(s.footprint))::json AS footprint,
              COALESCE(sn.snapshots, '[]'::json) AS snapshots,
              COALESCE(sn.size_bytes, 0) AS size_bytes
       FROM app.raster_layers l
       JOIN app.integrations i ON i.id = l.integration_id
       LEFT JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', id, 'observed_at', observed_at, 'observed_end', observed_end
                ) ORDER BY observed_at) AS snapshots,
                sum(size_bytes) AS size_bytes
         FROM app.raster_snapshots WHERE layer_id = l.id AND status = 'promoted'
       ) sn ON true
       WHERE l.id = $1 AND ${session ? "l.session_id = $2" : "l.session_id IS NULL"}`,
      session ? [layerMatch[1], session] : [layerMatch[1]]
    )
    if (result.rows.length === 0) {
      json(res, 404, { error: "unknown layer" })
      return
    }
    const row = result.rows[0]
    json(res, 200, {
      id: row.id,
      name: row.name,
      integrationId: row.integration_id,
      integrationName: row.integration_name ?? row.integration_id,
      temporality: row.temporality,
      bands: row.bands,
      currentSnapshotId: row.current_snapshot_id,
      observedAt: row.observed_at,
      observedEnd: row.observed_end,
      crs: row.crs,
      footprint: row.footprint,
      snapshots: row.snapshots,
      sizeBytes: Number(row.size_bytes)
    })
    return
  }

  const tileMatch = pathname.match(TILE_PATH)
  if (tileMatch) {
    const [, layerId, snapshotId, bandId, z, x, y] = tileMatch
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
    const band = bandId ? bands.find(b => b.id === bandId) : bands[0]
    if (!band) {
      json(res, 404, { error: `unknown band "${bandId}"` })
      return
    }
    const rendering = band.rendering ?? {}
    // A cancelled request (slider scrubbed past this snapshot) stops the
    // GDAL pipeline between steps instead of rendering pixels nobody wants
    const png = await tiles.tile(
      layerId,
      snapshotId,
      snapshot.rows[0].path,
      band.id,
      rendering,
      Number(z),
      Number(x),
      Number(y),
      () => !req.destroyed && !res.destroyed
    )
    if (png === null) {
      res.destroy()
      return
    }
    // Snapshot-pinned URL: content never changes, cache hard
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" })
    res.end(png)
    return
  }

  // The landing page: counts, panels and health in one round trip
  if (pathname === "/api/home") {
    json(
      res,
      200,
      await getHomeSummary(pool, libraryPath, {
        designer: agent !== null,
        dashboards: dashboardAgent !== null,
        assistant: assistantAgent !== null
      })
    )
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

  // The library: browsable entries, one-click install/update for editors
  if (pathname === "/api/library" && req.method === "GET") {
    json(res, 200, { entries: libraryPath ? await listLibrary(pool, libraryPath) : [] })
    return
  }
  // Skills: the library's source and technique know-how, readable by any
  // signed-in user. The agent loads these on demand; this is the human view.
  if (pathname === "/api/skills" && req.method === "GET") {
    json(res, 200, { skills: libraryPath ? loadSkillsIndex(skillsDir(libraryPath)) : [] })
    return
  }
  const skillMatch = pathname.match(/^\/api\/skills\/([a-z][a-z0-9_]*)$/)
  if (skillMatch && req.method === "GET") {
    const skill = libraryPath ? loadSkill(skillsDir(libraryPath), skillMatch[1]) : null
    if (!skill) {
      json(res, 404, { error: "No such skill" })
      return
    }
    json(res, 200, skill)
    return
  }

  const libraryInstallMatch = pathname.match(/^\/api\/library\/([a-z][a-z0-9_]*)\/install$/)
  if (libraryInstallMatch && req.method === "POST") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot install integrations" })
      return
    }
    if (!libraryPath) {
      json(res, 503, { error: "No library on this server" })
      return
    }
    const body = await readJsonBody(req)
    const result = await installLibraryEntry(pool, libraryPath, libraryInstallMatch[1], user.id)
    if (!result) {
      json(res, 404, { error: "unknown library entry" })
      return
    }
    // First ingest on request, when a job runner exists; install still succeeds without one
    let runId: string | null = null
    if (body.runNow === true && runs) {
      runId = await runs.start(libraryInstallMatch[1]).catch(() => null)
    }
    json(res, 200, { version: result.version, runId })
    return
  }

  // Export: the definition is the whole integration, so sharing is one JSON
  // file. The AOI stays home (deployment-owned); the importer's applies.
  const exportMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/export$/)
  if (exportMatch && req.method === "GET") {
    const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [exportMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const { aoi: _aoi, ...definition } = row.rows[0].definition
    res.writeHead(200, {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${exportMatch[1]}.integration.json"`
    })
    res.end(JSON.stringify(definition, null, 2))
    return
  }

  // Import installs a shared definition paused, so the operator can read the
  // code and run it manually before the scheduler touches it
  if (pathname === "/api/integrations/import" && req.method === "POST") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot import integrations" })
      return
    }
    const body = await readJsonBody(req)
    if (typeof body.id !== "string" || typeof body.code !== "string" || typeof body.runtime !== "string") {
      json(res, 400, { error: "Not an integration definition (id, runtime, and code are required)" })
      return
    }
    const exists = await pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [body.id])
    if (exists.rows.length > 0) {
      json(res, 409, { error: `Integration ${body.id} is already installed` })
      return
    }
    let version: number
    try {
      version = (await installIntegration(pool, body as unknown as IntegrationDefinition, "ready", user.id)).version
    } catch (err) {
      // Validation failures and destination-ownership conflicts alike
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    await pool.query("UPDATE app.integrations SET enabled = false WHERE id = $1", [body.id])
    json(res, 200, { id: body.id, version, enabled: false })
    return
  }

  // The webhook capability URL: readable by editors, rotation admin-only
  const webhookTokenMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/webhook-token$/)
  if (webhookTokenMatch && (req.method === "GET" || req.method === "POST")) {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot read webhook tokens" })
      return
    }
    if (req.method === "POST" && user.role !== "admin") {
      json(res, 403, { error: "Only admins can rotate webhook tokens" })
      return
    }
    const webhookToken =
      req.method === "POST"
        ? await rotateWebhookToken(pool, webhookTokenMatch[1])
        : await getWebhookToken(pool, webhookTokenMatch[1])
    if (!webhookToken) json(res, 404, { error: "unknown integration" })
    else json(res, 200, { token: webhookToken, path: `/hooks/${webhookToken}` })
    return
  }

  // Schedule is definition content: changing it archives a new attributed version
  const triggerMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/trigger$/)
  if (triggerMatch && req.method === "PUT") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot change integrations" })
      return
    }
    const row = await pool.query("SELECT definition, status FROM app.integrations WHERE id = $1", [triggerMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const body = await readJsonBody(req)
    const trigger: { cron?: string; webhook?: boolean; webhookDelaySeconds?: number } = {}
    try {
      if (typeof body.cron === "string" && body.cron.trim() !== "") {
        parseCron(body.cron)
        trigger.cron = body.cron.trim()
      } else if (body.cron !== undefined && body.cron !== null && body.cron !== "") {
        throw new Error("cron must be a string or null")
      }
      if (body.webhook === true) {
        trigger.webhook = true
        const delay = body.webhookDelaySeconds
        if (delay !== undefined && delay !== null && delay !== 0) {
          if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0 || delay > 86400) {
            throw new Error("webhookDelaySeconds must be an integer between 0 and 86400")
          }
          trigger.webhookDelaySeconds = delay
        }
      }
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    const definition = { ...row.rows[0].definition, trigger }
    const { version } = await installIntegration(pool, definition, row.rows[0].status, user.id)
    json(res, 200, { version, trigger })
    return
  }

  // Enabled is operational state, not spec: a plain column, not versioned
  const enabledMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/enabled$/)
  if (enabledMatch && req.method === "PUT") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot change integrations" })
      return
    }
    const body = await readJsonBody(req)
    if (typeof body.enabled !== "boolean") {
      json(res, 400, { error: "enabled must be a boolean" })
      return
    }
    const updated = await pool.query(
      "UPDATE app.integrations SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING enabled",
      [enabledMatch[1], body.enabled]
    )
    if (updated.rows.length === 0) json(res, 404, { error: "unknown integration" })
    else json(res, 200, { enabled: updated.rows[0].enabled })
    return
  }

  const integrationMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)$/)
  if (integrationMatch) {
    if (req.method === "DELETE") {
      if (user.role === "viewer") {
        json(res, 403, { error: "Viewers cannot delete integrations" })
        return
      }
      let result
      try {
        result = await deleteIntegration(pool, integrationMatch[1])
      } catch (err) {
        // Active runs and dependent integrations refuse with a clear message
        json(res, 409, { error: err instanceof Error ? err.message : String(err) })
        return
      }
      if (!result.ok) {
        json(res, 404, { error: "unknown integration" })
        return
      }
      // Best-effort file cleanup; orphans are disk-only and harmless
      for (const relPath of result.snapshotPaths) await store?.delete(relPath).catch(() => {})
      for (const layerId of result.layerIds) await tiles.dropLayer(layerId).catch(() => {})
      await runs?.removeWorkDir(integrationMatch[1]).catch(() => {})
      json(res, 200, { tables: result.tables, snapshots: result.snapshots, runs: result.runs, sessions: result.sessions })
      return
    }
    const detail = await getIntegration(pool, integrationMatch[1])
    if (!detail) json(res, 404, { error: "unknown integration" })
    else json(res, 200, detail)
    return
  }

  const usageMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/usage$/)
  if (usageMatch && req.method === "GET") {
    json(res, 200, await integrationUsage(pool, usageMatch[1]))
    return
  }

  const versionsMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/versions$/)
  if (versionsMatch && req.method === "GET") {
    const versions = await listIntegrationVersions(pool, versionsMatch[1])
    if (versions.length === 0) json(res, 404, { error: "unknown integration" })
    else json(res, 200, { versions })
    return
  }

  // AOI is definition content: changing it archives a new attributed version
  const aoiMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/aoi$/)
  if (aoiMatch && req.method === "PUT") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot change integrations" })
      return
    }
    const row = await pool.query("SELECT definition, status FROM app.integrations WHERE id = $1", [aoiMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const body = await readJsonBody(req)
    const definition = { ...row.rows[0].definition }
    try {
      const mode = String(body.mode ?? "")
      if (mode === "inherit") delete definition.aoi
      else if (mode === "full") definition.aoi = null
      else if (mode === "box") definition.aoi = parseAoi(body.aoi)
      else throw new Error('mode must be "inherit", "full", or "box"')
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    const { version } = await installIntegration(pool, definition, row.rows[0].status, user.id)
    json(res, 200, { version })
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
    if (req.method === "DELETE") {
      if (user.role === "viewer") {
        json(res, 403, { error: "Viewers cannot delete dashboards" })
        return
      }
      const result = await deleteDashboard(pool, dashboardMatch[1])
      if (!result.ok) json(res, 404, { error: "unknown dashboard" })
      else json(res, 200, { versions: result.versions, sessions: result.sessions })
      return
    }
    const detail = await getDashboard(pool, dashboardMatch[1])
    if (!detail) json(res, 404, { error: "unknown dashboard" })
    else json(res, 200, detail)
    return
  }

  const dashboardTileMatch = pathname.match(DASHBOARD_TILE_PATH)
  if (dashboardTileMatch && req.method === "GET") {
    const [, dashboardId, queryName, z, x, y] = dashboardTileMatch
    if (!canViewDashboard(user, dashboardId)) {
      json(res, 403, { error: "no access to this dashboard" })
      return
    }
    try {
      const mvt = await executeDashboardTileQuery(
        pool,
        dashboardId,
        queryName,
        tileParams(searchParams),
        Number(z),
        Number(x),
        Number(y)
      )
      if (mvt === null) {
        json(res, 404, { error: "unknown dashboard or tile query" })
        return
      }
      // Live data with bound filters: a short private cache absorbs pan/zoom
      // backtracking without serving stale tiles for long
      res.writeHead(200, { "content-type": MVT_CONTENT_TYPE, "cache-control": "private, max-age=60" })
      res.end(mvt)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
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
    await routeSessions(pool, agent, dashboardAgent, assistantAgent, user, req, res, url)
    return
  }

  if (req.method === "GET" && (await serveUi(url, res, uiDist))) return

  json(res, 404, { error: "not found" })
}

/** Handles the /api/sessions routes; design actions need editor or admin, assistant chats are open to viewers. */
async function routeSessions(
  pool: pg.Pool,
  agent: AgentService | null,
  dashboardAgent: AgentService | null,
  assistantAgent: AgentService | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  url: string
): Promise<void> {
  const isViewer = user.role === "viewer"
  const [pathname, search] = url.split("?")
  const searchParams = new URLSearchParams(search ?? "")

  // Creation first: the viewer rejection outranks the no-model 503
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await readJsonBody(req)
    const kind = body.kind === "dashboard" ? "dashboard" : body.kind === "assistant" ? "assistant" : "designer"
    if (isViewer && kind !== "assistant") {
      json(res, 403, { error: "Viewers cannot run design sessions" })
      return
    }
    const service = kind === "dashboard" ? dashboardAgent : kind === "assistant" ? assistantAgent : agent
    if (!service) {
      json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
      return
    }
    const bindId = kind === "dashboard" ? body.dashboardId : kind === "designer" ? body.integrationId : undefined
    const sessionId = await service.createSession(bindId == null || bindId === "" ? undefined : String(bindId), user.id)
    json(res, 201, { sessionId })
    return
  }

  if (!agent && !dashboardAgent && !assistantAgent) {
    json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
    return
  }

  if (pathname === "/api/sessions") {
    // Design sessions are team artifacts; assistant chats list per creator
    const lists = await Promise.all([agent?.listSessions(), dashboardAgent?.listSessions(), assistantAgent?.listSessions(user.id)])
    const sessions = lists
      .flatMap(l => l ?? [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    json(res, 200, { sessions })
    return
  }

  const match = pathname.match(SESSION_PATH)
  if (!match) {
    json(res, 404, { error: "not found" })
    return
  }
  const [, sessionId, sub] = match
  const owner = await pool.query("SELECT kind FROM app.agent_sessions WHERE id = $1", [sessionId])
  if (owner.rows.length === 0) {
    json(res, 404, { error: "unknown session" })
    return
  }
  const ownerKind: string = owner.rows[0].kind
  if (isViewer && req.method === "POST" && ownerKind !== "assistant") {
    json(res, 403, { error: "Viewers cannot run design sessions" })
    return
  }
  // Ahead of the service lookup: what may be deleted is a permission question,
  // and it is answerable whether or not that kind's model is configured
  if (!sub && req.method === "DELETE") {
    // Design sessions are team artifacts carrying runs and scratch layers;
    // only the personal assistant chats are the user's to throw away
    if (ownerKind !== "assistant") {
      json(res, 403, { error: "Only assistant chats can be deleted" })
      return
    }
    if (!assistantAgent) {
      json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
      return
    }
    const deleted = await assistantAgent.deleteSession(sessionId, user.role === "admin" ? undefined : user.id)
    if (!deleted) json(res, 403, { error: "Not your chat" })
    else json(res, 200, { ok: true })
    return
  }

  const agentService = ownerKind === "dashboard" ? dashboardAgent : ownerKind === "assistant" ? assistantAgent : agent
  if (!agentService) {
    json(res, 503, { error: "No model configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)" })
    return
  }

  if (!sub && req.method === "GET") {
    const detail = await agentService.getSession(sessionId)
    if (!detail) json(res, 404, { error: "unknown session" })
    else json(res, 200, detail)
    return
  }

  // Draft tile-query execution for the design-session preview map
  const tileMatch = sub?.match(/^\/tiles\/([a-z][a-z0-9_]*)\/(\d+)\/(\d+)\/(\d+)\.mvt$/)
  if (tileMatch && req.method === "GET") {
    const detail = await agentService.getSession(sessionId)
    const state = detail?.state as { queries?: DashboardQuery[] } | undefined
    const query = state?.queries?.find(q => q.name === tileMatch[1] && q.tile === true)
    if (!query) {
      json(res, 404, { error: "unknown draft tile query" })
      return
    }
    try {
      const mvt = await executeTileQuery(
        pool,
        query,
        tileParams(searchParams),
        Number(tileMatch[2]),
        Number(tileMatch[3]),
        Number(tileMatch[4])
      )
      // Draft queries change under the session; never cache preview tiles
      res.writeHead(200, { "content-type": MVT_CONTENT_TYPE, "cache-control": "no-store" })
      res.end(mvt)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
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
async function serveUi(url: string, res: ServerResponse, uiDist: string): Promise<boolean> {
  const requested = url === "/" ? "/index.html" : url.split("?")[0]
  const file = path.normalize(path.join(uiDist, requested))
  if (!file.startsWith(path.normalize(uiDist))) return false

  const target = await stat(file).then(s => (s.isFile() ? file : null)).catch(() => null)
  // SPA fallback: unknown paths get index.html (hash routing makes this rare)
  const resolved = target ?? (path.extname(requested) === "" ? path.join(uiDist, "index.html") : null)
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

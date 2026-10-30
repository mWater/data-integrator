import { createServer, request as httpRequest, Server, IncomingMessage, ServerResponse } from "node:http"
import { BasemapProxy } from "./basemap.js"
import { readFile, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { BandSpec, IntegrationDefinition } from "@data-integrator/definitions"
import { TileRenderer } from "./tiles.js"
import { ClientError, json, readJsonBody, sendFile } from "./http.js"
import { snapshotSources } from "./catalog.js"
import { AgentService, MessageRejectedError, SessionAttachment, SessionDeleteRefusedError } from "./agent/service.js"
import { saveDashboardSession } from "./agent/dashboard.js"
import { getIntegration, getTableRows, listIntegrations, listIntegrationVersions } from "./integrations.js"
import { getWebhookToken, receiveWebhook, rotateWebhookToken, WEBHOOK_TOKEN_PATTERN } from "./webhooks.js"
import { deleteIntegration, installIntegration, integrationUsage, validateDefinition } from "./install.js"
import { getHomeSummary } from "./home.js"
import { installLibraryEntry, listLibrary, loadLibraryEntry } from "./library.js"
import { parseCron } from "./cron.js"
import { loadSkill, loadSkillsIndex, skillsDir } from "./skills.js"
import { listSources, tableGeometry } from "./sources.js"
import { copySecret, deleteSecret, listAllSecrets, listSecrets, loadSecretKey, setSecret } from "./secrets.js"
import { RunRequestError, RunService } from "./runService.js"
import {
  deferContinue,
  FileApiOptions,
  handleSessionUpload,
  limitRequestTime,
  parseRunPins,
  REQUEST_DEADLINE_MS,
  routeIntegrationFiles,
  UPLOAD_PATH
} from "./filesApi.js"
import { RasterStore } from "./rasterStore.js"
import { listTables, parseRowsQuery, queryRows, rowsToCsv, rowsToGeoJson } from "./queryApi.js"
import {
  canViewDashboard,
  deleteDashboard,
  executeDashboardQuery,
  executeDashboardTileQuery,
  getDashboard,
  listDashboards,
  listDashboardVersions,
  renameDashboard,
  restoreDashboardVersion,
  saveDashboard,
  setDashboardPublic
} from "./dashboards/service.js"
import { DashboardQuery, executeStoredQuery, executeTableTileQuery, executeTileQuery } from "./dashboards/queries.js"
import { COUNTRIES } from "./countries.js"
import { refreshAoi } from "./aoi.js"
import { getLocales, LOCALES_KEY, parseLocales,
  DEFAULT_AOI_KEY,
  getDefaultAoi,
  DEFAULT_SITE_TITLE,
  getSiteTitle,
  parseAoi,
  parseDefaultAoi,
  parseSiteTitle,
  setSetting,
  SITE_TITLE_KEY
} from "./settings.js"
import {
  acknowledgeAi,
  authenticate,
  AuthUser,
  createApiToken,
  createAuthSession,
  deleteAuthSession,
  getAiAcknowledged,
  getSessionUser,
  getTokenUser,
  listApiTokens,
  revokeApiToken,
  setPassword,
  verifyPassword
} from "./auth.js"
import { AiProvider } from "./config.js"
import { LanguageModel } from "ai"
import { parseItemQuery, STAC_CONFORMANCE, stacCollection, stacCollections, stacItem, stacItems, stacLanding } from "./stac.js"
import { aiUsageToday, getAiLimits, parseAiLimits, saveAiLimits } from "./aiLimits.js"
import { ACCOUNT_POLICY_KEY, getAccountPolicy, parseAccountPolicy, saveAccountPolicy } from "./accountPolicy.js"
import { actorFields, auditWrite, logSecurityEvent, originFields } from "./securityLog.js"
import { AiRuntime, aiSettingsView, buildModel, parseAiConfig, saveAiConfig, testModel } from "./aiSettings.js"
import { SUPPORTED_LOCALES } from "@data-integrator/definitions"
import { catalogTranslationStatus, startCatalogTranslation, translateDefinition, wrapDefinitionStrings } from "./localizeCatalog.js"
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
  /^\/tiles\/([a-z][a-z0-9_]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([a-z][a-z0-9_]*))?\/(\d+)\/(\d+)\/(\d+)\.png$/

/** Matches /api/sessions/:id and captures the trailing subresource. */
const SESSION_PATH =
  /^\/api\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages|\/events|\/stop|\/save|\/files\/[^/]+|\/queries\/[a-z][a-z0-9_]*|\/secrets\/[A-Za-z_][A-Za-z0-9_]{0,63}\/check|\/tiles\/[a-z][a-z0-9_]*\/\d+\/\d+\/\d+\.mvt)?$/

/** Matches /api/dashboards/:id/tiles/:name/:z/:x/:y.mvt (stored tile queries). */
const DASHBOARD_TILE_PATH =
  /^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/tiles\/([a-z][a-z0-9_]*)\/(\d+)\/(\d+)\/(\d+)\.mvt$/

/** Matches /api/dashboards/:id/rastertiles/:layer/:snapshot[/:band]/:z/:x/:y.png (declared raster layers). */
const DASHBOARD_RASTER_TILE_PATH =
  /^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/rastertiles\/([a-z][a-z0-9_]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([a-z][a-z0-9_]*))?\/(\d+)\/(\d+)\/(\d+)\.png$/

/** A canonical lowercase UUID (snapshot, run and session ids). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
 * @param ai - Live AI settings; while AI is off the session services are
 *   withheld. Null leaves the services as given, with no provider
 * @param viteDevUrl - Live Vite origin; null serves the built SPA from dist
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
  assistantAgent: AgentService | null = null,
  ai: AiRuntime | null = null,
  viteDevUrl: string | null = null,
  files: FileApiOptions | null = null
): Server {
  const uiDist = uiDistPath ?? DEFAULT_UI_DIST
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    auditWrite(req, res, () => requestUsers.get(req) ?? null)
    if (!UPLOAD_PATH.test((req.url ?? "").split("?")[0])) limitRequestTime(req, res)
    try {
      // Read per request: an admin can switch the provider at any time
      const live = ai === null || ai.configured()
      const model = ai?.configured() ? ai.model : null
      await route(pool, tiles, live ? agent : null, runs, store, live ? dashboardAgent : null, basemap, uiDist, libraryPath,
        live ? assistantAgent : null, ai?.provider ?? null, viteDevUrl, model, files, ai, req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(err instanceof ClientError ? err.status : 500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  }
  const server = createServer(handle)
  // Large uploads on slow links outlast the five minute default; uploads
  // carry their own idle timeout, and limitRequestTime holds every other
  // request to the default
  server.requestTimeout = REQUEST_DEADLINE_MS
  // Uploads answer 100 Continue only after their checks pass, so a refused
  // upload is never sent; every other request continues at once
  server.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
    if (UPLOAD_PATH.test((req.url ?? "").split("?")[0])) deferContinue(req)
    else res.writeContinue()
    void handle(req, res)
  })
  return server
}


/** The user each request authenticated as, for the security log's write events. */
const requestUsers = new WeakMap<IncomingMessage, AuthUser>()

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
  aiProvider: AiProvider | null,
  viteDevUrl: string | null,
  model: LanguageModel | null,
  files: FileApiOptions | null,
  ai: AiRuntime | null,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/"
  const [pathname, search] = url.split("?")
  const searchParams = new URLSearchParams(search ?? "")

  // Kit runtime assets are public open-source code; versioned URLs cache hard
  const kitMatch = pathname.match(KIT_PATH)
  if (kitMatch && req.method === "GET") {
    const sent = await sendFile(res, path.join(KIT_ASSETS, kitMatch[1]), {
      "content-type": kitMatch[1].endsWith(".css") ? "text/css" : "text/javascript",
      "cache-control": "public, max-age=31536000, immutable",
      // Module scripts fetch with CORS from the opaque-origin dashboard frame
      "access-control-allow-origin": "*"
    })
    if (!sent) json(res, 404, { error: "no such kit asset" })
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
    const email = String(body.email ?? "")
    const password = String(body.password ?? "")
    let result = await authenticate(pool, email, password)
    // An expired password signs in only together with its replacement
    if (!result.ok && result.reason === "password-expired") {
      if (body.newPassword === undefined) {
        logSecurityEvent("auth.login", { outcome: "password-expired", email, ...originFields(req) })
        json(res, 401, { error: "Password expired; choose a new one", code: "password_expired" })
        return
      }
      const newPassword = String(body.newPassword)
      if (newPassword.length < 8 || newPassword === password) {
        json(res, 400, { error: "The new password must have at least 8 characters and differ from the old one" })
        return
      }
      await setPassword(pool, email, newPassword)
      logSecurityEvent("auth.password_renewed", { email, ...originFields(req) })
      result = await authenticate(pool, email, newPassword)
    }
    if (!result.ok) {
      logSecurityEvent("auth.login", { outcome: result.reason, email, ...originFields(req) })
      json(res, 401, { error: result.reason === "locked" ? "Account locked; try again later" : "Invalid email or password" })
      return
    }
    logSecurityEvent("auth.login", { outcome: "success", ...actorFields(result.user), ...originFields(req) })
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
  if (user) requestUsers.set(req, user)

  if (pathname === "/api/logout" && req.method === "POST") {
    if (token) await deleteAuthSession(pool, token)
    res.setHeader("set-cookie", sessionCookie(null, req))
    json(res, 200, { ok: true })
    return
  }

  if (pathname === "/api/me") {
    if (!user) {
      json(res, 401, { error: "not signed in" })
      return
    }
    // Hosted providers require the one-time data-processing acknowledgement;
    // a custom (self-hosted) endpoint keeps data on the admin's infrastructure
    const hosted = aiProvider === "openrouter" || aiProvider === "anthropic"
    json(res, 200, {
      user: { id: user.id, email: user.email, role: user.role },
      ai: {
        provider: aiProvider,
        model: ai?.modelId ?? null,
        ackRequired: hosted && !(await getAiAcknowledged(pool, user.id))
      }
    })
    return
  }

  // Basemap proxy: cached upstream style/sprite/glyph/tile bytes for map
  // frames. Public: it proxies open basemap tiles and carries no platform data,
  // and public dashboards need it without a session.
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

  // Dashboard view surface (detail, stored queries, tiles, meta): reachable
  // without a session so public dashboards render; per-dashboard visibility
  // is checked inside
  if (await routeDashboardView(pool, tiles, user, req, res, pathname, searchParams)) return

  // Everything below is either the static shell (public) or data (auth required)
  if (!user) {
    if (req.method === "GET" && !pathname.startsWith("/api") && !TILE_PATH.test(pathname)) {
      if (await serveUi(req, res, uiDist, viteDevUrl)) return
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
  // Secret names are whatever the definition declares: lowercase snake_case
  // by convention, environment-variable style accepted
  const intSecretMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/secrets\/([A-Za-z_][A-Za-z0-9_]{0,63})$/)
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
      settings: { default_aoi: await getDefaultAoi(pool), site_title: await getSiteTitle(pool), locales: await getLocales(pool) },
      supportedLocales: SUPPORTED_LOCALES,
      catalogTranslation: catalogTranslationStatus()
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
      await refreshAoi(pool, null)
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
    // The shape statistics clip to follows the setting
    await refreshAoi(pool, aoi)
    json(res, 200, { default_aoi: aoi })
    return
  }

  if (pathname === `/api/settings/${LOCALES_KEY}` && req.method === "PUT") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change settings" })
      return
    }
    let locales
    try {
      locales = parseLocales(await readJsonBody(req))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    // Adding a language is the one event that leaves the catalog untranslated,
    // so the translation pass starts here, in the background
    const previous = await getLocales(pool)
    await setSetting(pool, LOCALES_KEY, locales)
    const added = locales.filter(l => !previous.includes(l))
    const catalogTranslation =
      added.length > 0 && model ? startCatalogTranslation(pool, model, locales) : catalogTranslationStatus()
    json(res, 200, { locales, added, catalogTranslation })
    return
  }

  // Operator entry point for a full catalog translation pass (the settings
  // page triggers one automatically when a language is added). Runs in the
  // background; poll GET /api/settings for catalogTranslation.
  if (pathname === "/api/settings/translate-catalog" && req.method === "POST") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can translate the catalog" })
      return
    }
    if (!model) {
      json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
      return
    }
    json(res, 202, { catalogTranslation: startCatalogTranslation(pool, model, await getLocales(pool)) })
    return
  }

  // Model provider, key and model: admins only; the key is write-only
  if (pathname === "/api/settings/ai") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change the AI provider" })
      return
    }
    if (!ai) {
      json(res, 503, { error: "AI settings are not available on this server" })
      return
    }
    let secretKey: Buffer | null = null
    try {
      secretKey = loadSecretKey()
    } catch {
      secretKey = null
    }
    if (req.method === "GET") {
      json(res, 200, aiSettingsView(ai, secretKey))
      return
    }
    if (req.method === "DELETE") {
      await saveAiConfig(pool, secretKey, null)
      ai.apply(null)
      json(res, 200, aiSettingsView(ai, secretKey))
      return
    }
    if (req.method === "PUT") {
      let next
      try {
        next = parseAiConfig(await readJsonBody(req), ai.current)
        if (next.apiKey && !secretKey) throw new Error("Set INTEGRATOR_SECRET_KEY on the server before saving an API key")
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        return
      }
      try {
        await testModel(buildModel(next, null))
      } catch (err) {
        json(res, 400, { error: `The provider did not answer: ${err instanceof Error ? err.message : String(err)}`, code: "ai_test_failed" })
        return
      }
      const previous = ai.provider
      await saveAiConfig(pool, secretKey, next)
      ai.apply(next)
      // The data notice names the provider, so a different hosted provider
      // asks everyone again
      if (previous !== next.provider) await pool.query("UPDATE app.users SET ai_acknowledged_at = NULL")
      json(res, 200, aiSettingsView(ai, secretKey))
      return
    }
  }

  // Daily AI token caps: admins only
  if (pathname === "/api/settings/ai_limits") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change AI limits" })
      return
    }
    if (req.method === "PUT") {
      try {
        await saveAiLimits(pool, parseAiLimits(await readJsonBody(req)))
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        return
      }
    } else if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" })
      return
    }
    json(res, 200, { limits: await getAiLimits(pool), usedToday: (await aiUsageToday(pool, null)).deployment })
    return
  }

  // Optional password expiry and inactivity disabling: admins only
  if (pathname === `/api/settings/${ACCOUNT_POLICY_KEY}`) {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can change the account policy" })
      return
    }
    if (req.method === "PUT") {
      try {
        await saveAccountPolicy(pool, parseAccountPolicy(await readJsonBody(req)))
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        return
      }
    } else if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" })
      return
    }
    json(res, 200, { policy: await getAccountPolicy(pool) })
    return
  }

  // One-time acknowledgement that AI features send data to the model provider
  if (pathname === "/api/me/ai-acknowledge" && req.method === "POST") {
    await acknowledgeAi(pool, user.id)
    json(res, 200, { ok: true })
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

  if (pathname === "/api/tokens") {
    if (req.method === "POST") {
      const body = await readJsonBody(req)
      const name = String(body.name ?? "").trim()
      if (!name) {
        json(res, 400, { error: "name is required" })
        return
      }
      const expiresDays = body.expiresDays === undefined ? undefined : Number(body.expiresDays)
      if (expiresDays !== undefined && (!Number.isInteger(expiresDays) || expiresDays < 1)) {
        json(res, 400, { error: "expiresDays must be a whole number of days, at least 1" })
        return
      }
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

  // One file of a snapshot; ?source=<ordinal> picks among a multi-file
  // snapshot's files (default the first). Empty snapshots have nothing to send.
  const downloadMatch = pathname.match(/^\/api\/snapshots\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download$/)
  if (downloadMatch && store) {
    const ordinal = Number(searchParams.get("source") ?? "0")
    const source = await pool.query(
      `SELECT s.layer_id, src.path, (SELECT count(*) FROM app.raster_sources WHERE snapshot_id = s.id)::int AS sources
       FROM app.raster_snapshots s
       LEFT JOIN app.raster_sources src ON src.snapshot_id = s.id AND src.ordinal = $2
       WHERE s.id = $1`,
      [downloadMatch[1], Number.isInteger(ordinal) ? ordinal : -1]
    )
    if (source.rows.length === 0) {
      json(res, 404, { error: "unknown snapshot" })
      return
    }
    const { layer_id, path: relPath, sources } = source.rows[0]
    if (relPath === null) {
      json(res, 404, { error: sources === 0 ? "empty snapshot" : `unknown source; snapshot has ${sources}` })
      return
    }
    const suffix = sources > 1 ? `_${ordinal}` : ""
    const sent = await sendFile(res, store.absolute(relPath), {
      "content-type": "image/tiff",
      "content-disposition": `attachment; filename="${layer_id}_${downloadMatch[1]}${suffix}.tif"`
    })
    // A catalogued file missing from the store (deleted, or an unmounted store)
    if (!sent) json(res, 404, { error: "snapshot file is missing from the raster store" })
    return
  }

  // STAC view of the raster catalog (stac.ts). Links are absolute, built from
  // the request's host as the client reached it (through any proxy).
  if (pathname === "/api/stac" || pathname.startsWith("/api/stac/")) {
    if (req.method !== "GET") {
      json(res, 405, { error: "GET only" })
      return
    }
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http"
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost")
    const apiBase = `${proto}://${host}/api`
    const base = `${apiBase}/stac`
    const lang = searchParams.get("lang")
    const locale = lang && SUPPORTED_LOCALES.some(l => l.code === lang) ? lang : "en"
    const sub = pathname.slice("/api/stac".length)
    const itemsMatch = sub.match(/^\/collections\/([a-z][a-z0-9_]*)\/items$/)
    const itemMatch = sub.match(/^\/collections\/([a-z][a-z0-9_]*)\/items\/([0-9a-f-]{36})$/)
    const collectionMatch = sub.match(/^\/collections\/([a-z][a-z0-9_]*)$/)
    let body: object | null = null
    let type = "application/json"
    if (sub === "" || sub === "/") {
      body = await stacLanding(pool, base, (await getSiteTitle(pool)) ?? DEFAULT_SITE_TITLE)
    } else if (sub === "/conformance") {
      body = { conformsTo: STAC_CONFORMANCE }
    } else if (sub === "/collections") {
      body = await stacCollections(pool, base, locale)
    } else if (collectionMatch) {
      body = await stacCollection(pool, base, locale, collectionMatch[1])
    } else if (itemsMatch) {
      let query
      try {
        query = parseItemQuery(searchParams)
      } catch (err) {
        json(res, 400, { code: "InvalidParameterValue", description: err instanceof Error ? err.message : String(err) })
        return
      }
      body = await stacItems(pool, base, apiBase, itemsMatch[1], query)
      type = "application/geo+json"
    } else if (itemMatch) {
      body = await stacItem(pool, base, apiBase, itemMatch[1], itemMatch[2])
      type = "application/geo+json"
    }
    if (body === null) {
      json(res, 404, { code: "NotFound", description: "Not found" })
      return
    }
    res.writeHead(200, { "content-type": type })
    res.end(JSON.stringify(body))
    return
  }

  if (pathname === "/api/layers") {
    // Default: installed layers only. ?session=<id> instead lists that design
    // session's scratch preview layers.
    const session = searchParams.get("session")
    const result = await pool.query(
      `SELECT l.id, l.name, l.temporality, l.bands, l.current_snapshot_id,
              s.observed_at, s.observed_end, s.crs, s.cell_size_m,
              ST_AsGeoJSON(ST_Envelope(s.footprint))::json AS footprint,
              COALESCE(sn.snapshots, '[]'::json) AS snapshots,
              (l.mask_geom IS NOT NULL) AS masked,
              left(md5(ST_AsBinary(l.mask_geom)::text), 8) AS mask_key
       FROM app.raster_layers l
       LEFT JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', id, 'observed_at', observed_at, 'observed_end', observed_end,
                  'sources', (SELECT count(*) FROM app.raster_sources WHERE snapshot_id = s2.id)
                ) ORDER BY observed_at) AS snapshots
         FROM app.raster_snapshots s2 WHERE layer_id = l.id AND status = 'promoted'
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
      `SELECT l.id, l.name, l.temporality, l.bands, l.current_snapshot_id, l.retention_days,
              l.integration_id, i.definition->'name' AS integration_name,
              i.definition->'description' AS integration_description,
              i.definition->'source' AS source,
              s.observed_at, s.observed_end, s.crs, s.cell_size_m, s.metadata,
              ST_AsGeoJSON(ST_Envelope(s.footprint))::json AS footprint,
              COALESCE(sn.snapshots, '[]'::json) AS snapshots,
              COALESCE(sn.size_bytes, 0) AS size_bytes,
              (l.mask_geom IS NOT NULL) AS masked,
              left(md5(ST_AsBinary(l.mask_geom)::text), 8) AS mask_key
       FROM app.raster_layers l
       JOIN app.integrations i ON i.id = l.integration_id
       LEFT JOIN app.raster_snapshots s ON s.id = l.current_snapshot_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', id, 'observed_at', observed_at, 'observed_end', observed_end,
                  'sources', (SELECT count(*) FROM app.raster_sources WHERE snapshot_id = s2.id)
                ) ORDER BY observed_at) AS snapshots,
                sum(size_bytes) AS size_bytes
         FROM app.raster_snapshots s2 WHERE layer_id = l.id AND status = 'promoted'
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
      retentionDays: row.retention_days,
      bands: row.bands,
      masked: row.masked,
      maskKey: row.mask_key ?? null,
      currentSnapshotId: row.current_snapshot_id,
      observedAt: row.observed_at,
      observedEnd: row.observed_end,
      crs: row.crs,
      cellSizeM: row.cell_size_m,
      metadata: row.metadata,
      footprint: row.footprint,
      snapshots: row.snapshots,
      sizeBytes: Number(row.size_bytes),
      description: row.integration_description,
      source: row.source
    })
    return
  }

  // Pixel value at a WGS84 point, for click-to-inspect on the layer page.
  const sampleMatch = pathname.match(/^\/api\/layers\/([a-z][a-z0-9_]*)\/sample$/)
  if (sampleMatch && req.method === "GET") {
    const lon = Number(searchParams.get("lon"))
    const lat = Number(searchParams.get("lat"))
    const snapshotId = searchParams.get("snapshot")
    if (!snapshotId || !UUID.test(snapshotId) || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      json(res, 400, { error: "snapshot, lon, and lat are required (WGS84)" })
      return
    }
    const session = searchParams.get("session")
    const snapshot = await pool.query(
      `SELECT l.bands FROM app.raster_snapshots s
       JOIN app.raster_layers l ON l.id = s.layer_id
       WHERE s.id = $1 AND s.layer_id = $2
         AND ${session ? "l.session_id = $3" : "l.session_id IS NULL"}`,
      session ? [snapshotId, sampleMatch[1], session] : [snapshotId, sampleMatch[1]]
    )
    if (snapshot.rows.length === 0) {
      json(res, 404, { error: "unknown snapshot" })
      return
    }
    const bands = snapshot.rows[0].bands as BandSpec[]
    const bandId = searchParams.get("band")
    const bandIndex = bandId ? bands.findIndex(b => b.id === bandId) : 0
    const band = bands[bandIndex]
    if (!band) {
      json(res, 404, { error: `unknown band "${bandId}"` })
      return
    }
    const sampled = await tiles.sample(await snapshotSources(pool, snapshotId), bandIndex + 1, lon, lat)
    const nodata = band.nodata
    const value =
      sampled == null || (nodata != null && Number.isFinite(nodata) && sampled === nodata) ? null : sampled
    json(res, 200, { value })
    return
  }

  const tileMatch = pathname.match(TILE_PATH)
  if (tileMatch) {
    const [, layerId, snapshotId, bandId, z, x, y] = tileMatch
    await serveRasterTile(pool, tiles, req, res, layerId, snapshotId, bandId, Number(z), Number(x), Number(y))
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

  // One entry in full (code elided): what the Library page shows when a row expands
  const libraryEntryMatch = pathname.match(/^\/api\/library\/([a-z][a-z0-9_]*)$/)
  if (libraryEntryMatch && req.method === "GET") {
    const definition = libraryPath ? await loadLibraryEntry(libraryPath, libraryEntryMatch[1]) : null
    if (!definition) {
      json(res, 404, { error: "unknown library entry" })
      return
    }
    const { code: _code, ...rest } = definition
    void _code
    json(res, 200, { definition: rest })
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
  // file. A concrete AOI stays home (deployment-owned) and the importer's
  // default applies; an explicit null (full extent) travels, since it is a
  // property of the source rather than of this deployment.
  const exportMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/export$/)
  if (exportMatch && req.method === "GET") {
    const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [exportMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const { aoi, ...rest } = row.rows[0].definition
    const definition = aoi === null ? { ...rest, aoi: null } : rest
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
      const definition = wrapDefinitionStrings(body as unknown as IntegrationDefinition, "en")
      version = (await installIntegration(pool, definition, "ready", user.id, false)).version
    } catch (err) {
      // Validation failures and destination-ownership conflicts alike
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
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
      // Remove each layer's whole store directory: failed runs can leave
      // artifacts no snapshot row points to
      for (const layerId of result.layerIds) {
        if (store) await rm(store.absolute(layerId), { recursive: true, force: true }).catch(() => {})
        await tiles.dropLayer(layerId).catch(() => {})
      }
      await runs?.removeWorkDir(integrationMatch[1]).catch(() => {})
      for (const file of result.files) await files?.store.deleteVersion(file.id, file.ext).catch(() => {})
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

  // Setting values are definition content too: each change archives a new
  // attributed version. { values: { id: value | null } }; null restores the default
  const settingsMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/settings$/)
  if (settingsMatch && req.method === "PUT") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot change integrations" })
      return
    }
    const row = await pool.query("SELECT definition, status FROM app.integrations WHERE id = $1", [settingsMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const body = await readJsonBody(req)
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
      json(res, 400, { error: "values must be an object of { settingId: value | null }" })
      return
    }
    const definition = { ...row.rows[0].definition }
    const values: Record<string, unknown> = { ...(definition.settingValues ?? {}) }
    for (const [id, value] of Object.entries(body.values as Record<string, unknown>)) {
      if (value === null) delete values[id]
      else values[id] = value
    }
    if (Object.keys(values).length > 0) definition.settingValues = values
    else delete definition.settingValues
    try {
      validateDefinition(definition)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    const { version } = await installIntegration(pool, definition, row.rows[0].status, user.id)
    json(res, 200, { version })
    return
  }

  // Display-name edit: the id in the URL is permanent, the name is a definition
  // field, so this archives a new version like the schedule and AOI edits do.
  // The new text is authored in the caller's interface language and translated
  // into the deployment's other languages when a model is configured.
  const nameMatch = pathname.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)\/name$/)
  if (nameMatch && req.method === "PUT") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot change integrations" })
      return
    }
    const row = await pool.query("SELECT definition, status FROM app.integrations WHERE id = $1", [nameMatch[1]])
    if (row.rows.length === 0) {
      json(res, 404, { error: "unknown integration" })
      return
    }
    const body = await readJsonBody(req)
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name || name.length > 200) {
      json(res, 400, { error: "name must be 1-200 characters" })
      return
    }
    const locale =
      typeof body.locale === "string" && SUPPORTED_LOCALES.some(l => l.code === body.locale) ? body.locale : "en"
    const definition = { ...row.rows[0].definition, name: { _base: locale, [locale]: name } }
    if (model) {
      try {
        await translateDefinition(model, definition, await getLocales(pool))
      } catch (err) {
        console.warn(`rename ${nameMatch[1]}: translation skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const { version } = await installIntegration(pool, definition, row.rows[0].status, user.id)
    json(res, 200, { version, name: definition.name })
    return
  }

  // Uploads, listing, and downloads of integration files
  if (await routeIntegrationFiles(pool, files, runs, user, req, res, pathname, searchParams)) return

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
      // Optional { files: { slotId: versionId } }: a revert or multi-slot
      // replace, which starts or queues; { rebuild: true }: a cold run that
      // produces everything in scope again; neither: a plain manual run
      const body = await readJsonBody(req)
      const pins = parseRunPins(body)
      if (body.rebuild !== undefined && typeof body.rebuild !== "boolean") {
        throw new RunRequestError("rebuild must be true or false")
      }
      if (pins && body.rebuild === true) throw new RunRequestError("A rebuild reads the current files; it takes no pins")
      if (pins) {
        const started = await runs.startPinned(runMatch[1], pins)
        json(res, 202, { runId: started.runId, status: started.status })
      } else {
        const trigger = body.rebuild === true ? "rebuild" : "manual"
        json(res, 202, { runId: await runs.start(runMatch[1], trigger), status: "running" })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status =
        err instanceof RunRequestError || err instanceof SyntaxError
          ? 400
          : /already (queued|running)|is a draft/.test(message)
            ? 409
            : message.includes("Unknown")
              ? 404
              : 500
      json(res, status, { error: message })
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
        queries: (body.queries ?? []) as never,
        layers: (body.layers ?? []) as never,
        createdBy: user.id
      })
      if (result.ok) json(res, 201, { version: result.version })
      else json(res, 400, { errors: result.errors })
    } else {
      json(res, 200, { dashboards: await listDashboards(pool) })
    }
    return
  }

  const dashboardMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)$/)
  if (dashboardMatch && req.method === "DELETE") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot delete dashboards" })
      return
    }
    const result = await deleteDashboard(pool, dashboardMatch[1])
    if (!result.ok) json(res, 404, { error: "unknown dashboard" })
    else json(res, 200, { versions: result.versions, sessions: result.sessions })
    return
  }

  const dashboardVersionsMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/versions$/)
  if (dashboardVersionsMatch && req.method === "GET") {
    const versions = await listDashboardVersions(pool, dashboardVersionsMatch[1])
    if (!versions) json(res, 404, { error: "unknown dashboard" })
    else json(res, 200, { versions })
    return
  }

  // Restore: copies an earlier version as the new current one. It changes what
  // everyone sees (the public too, for a public dashboard), so it takes the
  // same role as saving
  const dashboardRestoreMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/versions\/(\d+)\/restore$/)
  if (dashboardRestoreMatch && req.method === "POST") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot restore dashboard versions" })
      return
    }
    const result = await restoreDashboardVersion(pool, dashboardRestoreMatch[1], Number(dashboardRestoreMatch[2]), user.id)
    if (result.ok) json(res, 201, { version: result.version })
    else json(res, result.notFound ? 404 : 400, { error: result.error })
    return
  }

  // Rename: new slug and/or display name; references cascade with the id.
  // Old links (public ones included) break - the UI warns before renaming
  const dashboardRenameMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/rename$/)
  if (dashboardRenameMatch && req.method === "POST") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot rename dashboards" })
      return
    }
    const body = await readJsonBody(req)
    const newId = String(body.id ?? dashboardRenameMatch[1])
    const newName = body.name === undefined ? null : String(body.name)
    const result = await renameDashboard(pool, dashboardRenameMatch[1], newId, newName)
    if (!result.ok) json(res, result.error === "unknown dashboard" ? 404 : 400, { error: result.error })
    else json(res, 200, { id: newId })
    return
  }

  // Public toggle: a public dashboard's view surface (bundle, stored queries,
  // declared raster layers) opens to anyone on the internet, so it is an
  // admin decision and recorded as such
  const dashboardPublicMatch = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)\/public$/)
  if (dashboardPublicMatch && req.method === "PUT") {
    if (user.role !== "admin") {
      json(res, 403, { error: "Only admins can make dashboards public or private" })
      return
    }
    const body = await readJsonBody(req)
    const isPublic = body.public === true
    if (await setDashboardPublic(pool, dashboardPublicMatch[1], isPublic, user.id)) json(res, 200, { public: isPublic })
    else json(res, 404, { error: "unknown dashboard" })
    return
  }

  if (pathname.startsWith("/api/sessions")) {
    await routeSessions(pool, agent, dashboardAgent, assistantAgent, aiProvider, files, user, req, res, url)
    return
  }

  if (req.method === "GET" && (await serveUi(req, res, uiDist, viteDevUrl))) return

  json(res, 404, { error: "not found" })
}

/**
 * The dashboard view surface: detail, stored queries, vector tiles, declared
 * raster tiles, and freshness meta. Runs ahead of the auth gate so public
 * dashboards render without a session; every handler checks per-dashboard
 * visibility (any signed-in user, or the public flag). Returns true when the
 * request was handled here.
 */
async function routeDashboardView(
  pool: pg.Pool,
  tiles: TileRenderer,
  user: AuthUser | null,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
): Promise<boolean> {
  const match = pathname.match(/^\/api\/dashboards\/([a-z][a-z0-9_-]*)(\/.*)?$/)
  if (!match) return false
  const [, dashboardId, sub] = match

  // Only the view surface is served here; management (list, save, delete,
  // publish) stays behind the auth gate
  const isView =
    (sub === undefined && req.method === "GET") ||
    (sub === "/meta" && req.method === "GET") ||
    (sub === "/sources" && req.method === "GET") ||
    (sub?.startsWith("/queries/") === true && req.method === "POST") ||
    (sub?.startsWith("/tiles/") === true && req.method === "GET") ||
    (sub?.startsWith("/rastertiles/") === true && req.method === "GET")
  if (!isView) return false

  const detail = await getDashboard(pool, dashboardId)
  // An anonymous viewer learns nothing about what exists: absent and private
  // dashboards answer identically
  if (!detail || !canViewDashboard(user, detail)) {
    if (!user) json(res, 401, { error: "sign in required" })
    else json(res, 404, { error: "unknown dashboard" })
    return true
  }

  if (sub === undefined) {
    // Source and SQL are editor-facing, and who published is personal data;
    // anonymous viewers get only what the frame needs to mount
    if (user) json(res, 200, detail)
    else {
      const { source, queries, publishedBy, ...viewable } = detail
      void source
      void queries
      void publishedBy
      json(res, 200, viewable)
    }
    return true
  }

  if (sub === "/sources") {
    // What the dashboard reads, for people: the tables its frozen queries
    // reference (matched by id against the catalog, since the SQL runs with
    // search_path = data) and the raster layers it declares
    const catalog = await listSources(pool)
    const sqlText = (detail.queries ?? []).map(q => q.sql).join("\n")
    const used = catalog.filter(source =>
      source.kind === "raster"
        ? detail.layers.includes(source.id)
        : new RegExp(`(^|[^A-Za-z0-9_])${source.id}([^A-Za-z0-9_]|$)`).test(sqlText)
    )
    json(res, 200, {
      sources: used.map(source => ({
        kind: source.kind,
        id: source.id,
        name: source.name,
        description: source.description,
        integrationId: source.integrationId,
        integrationName: source.integrationName,
        updatedAt: source.updatedAt
      }))
    })
    return true
  }

  if (sub === "/meta") {
    // Freshness and snapshot timelines for the frame: every table's update
    // time (ids and timestamps only), declared layers in full
    const sources = await listSources(pool)
    const tables: Record<string, string | null> = {}
    for (const source of sources) if (source.kind === "table") tables[source.id] = source.updatedAt
    const layerRows =
      detail.layers.length === 0
        ? []
        : (
            await pool.query(
              `SELECT l.id, l.name, l.temporality, l.current_snapshot_id,
                      COALESCE(sn.snapshots, '[]'::json) AS snapshots,
                      left(md5(ST_AsBinary(l.mask_geom)::text), 8) AS mask_key
               FROM app.raster_layers l
               LEFT JOIN LATERAL (
                 SELECT json_agg(json_build_object(
                          'id', id, 'observedAt', observed_at, 'observedEnd', observed_end
                        ) ORDER BY observed_at) AS snapshots
                 FROM app.raster_snapshots WHERE layer_id = l.id AND status = 'promoted'
               ) sn ON true
               WHERE l.id = ANY($1) AND l.session_id IS NULL
               ORDER BY l.id`,
              [detail.layers]
            )
          ).rows
    json(res, 200, {
      tables,
      layers: layerRows.map(row => ({
        id: row.id,
        name: row.name,
        temporality: row.temporality,
        currentSnapshotId: row.current_snapshot_id,
        snapshots: row.snapshots,
        maskKey: row.mask_key ?? null
      }))
    })
    return true
  }

  const queryMatch = pathname.match(/^\/api\/dashboards\/[a-z][a-z0-9_-]*\/queries\/([a-z][a-z0-9_]*)$/)
  if (queryMatch) {
    const body = await readJsonBody(req)
    try {
      const rows = await executeDashboardQuery(pool, dashboardId, queryMatch[1], (body.params ?? {}) as Record<string, unknown>)
      if (rows === null) json(res, 404, { error: "unknown query" })
      else json(res, 200, { rows })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  const tileMatch = pathname.match(DASHBOARD_TILE_PATH)
  if (tileMatch) {
    const [, , queryName, z, x, y] = tileMatch
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
        json(res, 404, { error: "unknown tile query" })
        return true
      }
      // Live data with bound filters: a short private cache absorbs pan/zoom
      // backtracking without serving stale tiles for long
      res.writeHead(200, { "content-type": MVT_CONTENT_TYPE, "cache-control": "private, max-age=60" })
      res.end(mvt)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  const rasterMatch = pathname.match(DASHBOARD_RASTER_TILE_PATH)
  if (rasterMatch) {
    const [, , layerId, snapshotId, bandId, z, x, y] = rasterMatch
    if (!detail.layers.includes(layerId)) {
      json(res, 404, { error: "layer not declared by this dashboard" })
      return true
    }
    await serveRasterTile(pool, tiles, req, res, layerId, snapshotId, bandId, Number(z), Number(x), Number(y))
    return true
  }

  json(res, 404, { error: "not found" })
  return true
}

/** Renders and serves one raster snapshot tile (shared by the catalog and dashboard-scoped routes). */
async function serveRasterTile(
  pool: pg.Pool,
  tiles: TileRenderer,
  req: IncomingMessage,
  res: ServerResponse,
  layerId: string,
  snapshotId: string,
  bandId: string | undefined,
  z: number,
  x: number,
  y: number
): Promise<void> {
  // The layer's mask (its integration's area as a shape) clips the drawing
  // unless the request opts out with ?mask=0; a short hash of the shape keys
  // the cached tiles, and the renderer fetches the GeoJSON once per hash
  const wantMask = new URL(req.url ?? "/", "http://localhost").searchParams.get("mask") !== "0"
  const snapshot = await pool.query(
    `SELECT l.bands,
            CASE WHEN $3 THEN left(md5(ST_AsBinary(l.mask_geom)::text), 8) END AS mask_key
     FROM app.raster_snapshots s
     JOIN app.raster_layers l ON l.id = s.layer_id
     WHERE s.id = $1 AND s.layer_id = $2`,
    [snapshotId, layerId, wantMask]
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
  const maskKey = snapshot.rows[0].mask_key as string | null
  const mask = maskKey
    ? {
        key: maskKey,
        geojson: async () => {
          const shape = await pool.query("SELECT ST_AsGeoJSON(mask_geom) AS geojson FROM app.raster_layers WHERE id = $1", [layerId])
          return shape.rows[0]?.geojson as string
        }
      }
    : null
  // A cancelled request (slider scrubbed past this snapshot) stops the
  // GDAL pipeline between steps instead of rendering pixels nobody wants
  const png = await tiles.tile(
    layerId,
    snapshotId,
    await snapshotSources(pool, snapshotId),
    band.id,
    rendering,
    z,
    x,
    y,
    () => !req.destroyed && !res.destroyed,
    mask
  )
  if (png === null) {
    res.destroy()
    return
  }
  // Snapshot-pinned URL: content never changes, cache hard, but only in the
  // viewer's browser: tiles are access-controlled, so shared caches must not keep them
  res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" })
  res.end(png)
}

/** Handles the /api/sessions routes; design actions need editor or admin, assistant chats are open to viewers. */
async function routeSessions(
  pool: pg.Pool,
  agent: AgentService | null,
  dashboardAgent: AgentService | null,
  assistantAgent: AgentService | null,
  aiProvider: AiProvider | null,
  files: FileApiOptions | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  url: string
): Promise<void> {
  const isViewer = user.role === "viewer"
  const [pathname, search] = url.split("?")
  const searchParams = new URLSearchParams(search ?? "")

  // A hosted provider means every session send leaves the deployment, so the
  // one-time acknowledgement is enforced here, not just in the UI: creating a
  // session and posting a message are the only doors to the model
  async function ackMissing(): Promise<boolean> {
    if (aiProvider !== "openrouter" && aiProvider !== "anthropic") return false
    if (await getAiAcknowledged(pool, user.id)) return false
    json(res, 403, {
      error: "AI features require a one-time data-processing acknowledgement (POST /api/me/ai-acknowledge; the app shows the notice)",
      code: "ai_ack_required"
    })
    return true
  }

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
      json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
      return
    }
    if (await ackMissing()) return
    const bindId = kind === "dashboard" ? body.dashboardId : kind === "designer" ? body.integrationId : undefined
    const locale = typeof body.locale === "string" && SUPPORTED_LOCALES.some(l => l.code === body.locale) ? body.locale : undefined
    const sessionId = await service.createSession(bindId == null || bindId === "" ? undefined : String(bindId), user.id, locale)
    json(res, 201, { sessionId })
    return
  }

  if (!agent && !dashboardAgent && !assistantAgent) {
    json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
    return
  }

  if (pathname === "/api/sessions") {
    // Design sessions are team artifacts, editor-only (transcripts carry what
    // the agent saw, file names and contents included); assistant chats list
    // per creator
    const lists = await Promise.all([
      isViewer ? [] : agent?.listSessions(),
      dashboardAgent?.listSessions(),
      assistantAgent?.listSessions(user.id)
    ])
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
  const owner = await pool.query("SELECT kind, user_id FROM app.agent_sessions WHERE id = $1", [sessionId])
  if (owner.rows.length === 0) {
    json(res, 404, { error: "unknown session" })
    return
  }
  const ownerKind: string = owner.rows[0].kind
  // Explore chats are private to their creator: admins may read and delete
  // other people's, and nobody else learns that they exist
  if (ownerKind === "assistant" && owner.rows[0].user_id !== user.id) {
    const adminRead = user.role === "admin" && (req.method === "GET" || req.method === "DELETE")
    if (!adminRead) {
      json(res, 404, { error: "unknown session" })
      return
    }
  }
  if (isViewer && (ownerKind === "designer" || (req.method !== "GET" && ownerKind !== "assistant"))) {
    json(res, 403, { error: "Viewers cannot open integration design sessions" })
    return
  }
  // A design session's file attachment, staged before the message carrying it
  const fileMatch = sub?.match(/^\/files\/([^/]+)$/)
  if (fileMatch && req.method === "PUT") {
    await handleSessionUpload(pool, files, user, req, res, sessionId, fileMatch[1], searchParams)
    return
  }
  // Ahead of the service lookup: what may be deleted is a permission question,
  // and it is answerable whether or not that kind's model is configured
  if (!sub && req.method === "DELETE" && ownerKind === "dashboard") {
    // Discard Changes: a dashboard draft is its creator's (or an admin's) to
    // throw away; saved versions live in app.dashboards and are untouched
    if (!dashboardAgent) {
      json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
      return
    }
    const deleted = await dashboardAgent.deleteSession(sessionId, user.role === "admin" ? undefined : user.id)
    if (!deleted) json(res, 403, { error: "Only the person who started this dashboard session can discard it" })
    else json(res, 200, { ok: true })
    return
  }
  if (sub === "/save" && req.method === "POST") {
    if (ownerKind !== "dashboard") {
      json(res, 400, { error: "Only dashboard sessions are saved this way" })
      return
    }
    if (dashboardAgent?.isRunning(sessionId)) {
      json(res, 409, { error: "The agent is still working; save once it has finished its turn" })
      return
    }
    const body = await readJsonBody(req)
    const result = await saveDashboardSession(
      pool,
      sessionId,
      {
        id: typeof body.id === "string" ? body.id : undefined,
        name: typeof body.name === "string" ? body.name : undefined
      },
      user.id
    )
    if (result.ok) json(res, 200, { dashboardId: result.dashboardId, version: result.version })
    else json(res, 400, { error: result.error })
    return
  }
  if (!sub && req.method === "DELETE" && ownerKind === "designer") {
    // A design session is its creator's (or an admin's) to delete while no
    // integration carries its id, which frees the id it claimed; once one
    // does, deleting the integration is what removes it
    if (!agent) {
      json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
      return
    }
    if (agent.isRunning(sessionId)) {
      json(res, 409, { error: "The agent is still working; stop it first" })
      return
    }
    try {
      const deleted = await agent.deleteSession(sessionId, user.role === "admin" ? undefined : user.id)
      if (!deleted) json(res, 403, { error: "Only the person who started this design session can delete it" })
      else json(res, 200, { ok: true })
    } catch (err) {
      if (!(err instanceof SessionDeleteRefusedError)) throw err
      json(res, 409, { error: err.message })
    }
    return
  }
  if (!sub && req.method === "DELETE") {
    // Assistant chats are the user's to throw away
    if (ownerKind !== "assistant") {
      json(res, 403, { error: "Only assistant chats, dashboard drafts and design sessions can be deleted" })
      return
    }
    if (!assistantAgent) {
      json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
      return
    }
    const deleted = await assistantAgent.deleteSession(sessionId, user.role === "admin" ? undefined : user.id)
    if (!deleted) json(res, 403, { error: "Not your chat" })
    else json(res, 200, { ok: true })
    return
  }

  const agentService = ownerKind === "dashboard" ? dashboardAgent : ownerKind === "assistant" ? assistantAgent : agent
  if (!agentService) {
    json(res, 503, { error: "AI features are off: an admin sets the model provider in Settings" })
    return
  }

  if (!sub && req.method === "GET") {
    const detail = await agentService.getSession(sessionId)
    if (!detail) json(res, 404, { error: "unknown session" })
    else json(res, 200, detail)
    return
  }

  // Credentials card: verify a just-saved secret with the agent's check snippet
  const checkMatch = sub?.match(/^\/secrets\/([A-Za-z_][A-Za-z0-9_]{0,63})\/check$/)
  if (checkMatch && req.method === "POST") {
    try {
      json(res, 200, await agentService.checkSecret(sessionId, checkMatch[1]))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      json(res, message.includes("busy") ? 409 : 400, { error: message })
    }
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
    if (await ackMissing()) return
    const body = await readJsonBody(req)
    const text = String(body.text ?? "").trim()
    if (!text) {
      json(res, 400, { error: "text is required" })
      return
    }
    // Files staged through PUT /files/:slot, recorded as the session's pins
    const attachments = body.files ?? []
    if (
      !Array.isArray(attachments) ||
      !attachments.every(a => a && typeof a === "object" && typeof a.slot === "string" && typeof a.versionId === "string")
    ) {
      json(res, 400, { error: "files must be a list of { slot, versionId }" })
      return
    }
    try {
      await agentService.send(sessionId, text, attachments as SessionAttachment[])
      json(res, 202, { accepted: true })
    } catch (err) {
      json(res, err instanceof MessageRejectedError ? 400 : 409, { error: err instanceof Error ? err.message : String(err) })
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

/** Serves the SPA: Vite during `pnpm dev`, otherwise the built dist. */
async function serveUi(
  req: IncomingMessage,
  res: ServerResponse,
  uiDist: string,
  viteDevUrl: string | null
): Promise<boolean> {
  if (viteDevUrl) return proxyVite(req, res, viteDevUrl)

  const requested = (req.url ?? "/") === "/" ? "/index.html" : (req.url ?? "/").split("?")[0]
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

/**
 * Reverse-proxies one GET to the Vite dev server so the operator UI on PORT
 * hot-reloads. Returns false only if the URL is not something we should have
 * asked Vite for; connection failure is a 502, not a dist fallback, so a
 * missing Vite process cannot silently serve a stale build.
 */
function proxyVite(req: IncomingMessage, res: ServerResponse, viteDevUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    const target = new URL(req.url ?? "/", viteDevUrl)
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host }
      },
      up => {
        const headers = { ...up.headers }
        delete headers.connection
        delete headers["transfer-encoding"]
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
        resolve(true)
      }
    )
    upstream.on("error", err => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        res.end(
          `Vite is not running at ${viteDevUrl} (${err instanceof Error ? err.message : err}).\n` +
            `Start it with \`pnpm dev\` from the repository root, or unset VITE_DEV_URL to serve apps/ui/dist.`
        )
      }
      resolve(true)
    })
    req.pipe(upstream)
  })
}

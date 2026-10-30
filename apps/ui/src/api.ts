/** LocalizedString from ez-localize: _base names the authored locale. */
import type { LocalizedString } from "ez-localize"
import { currentLocale } from "./localization.js"
import type { SettingSpec, SettingValue } from "@data-integrator/definitions"

export type { SettingSpec, SettingValue }

/** Session summary row from GET /api/sessions. */
export interface SessionSummary {
  /** Session id */
  id: string
  /** Session kind */
  kind: "designer" | "dashboard" | "assistant"
  /** Session status: active, paused, or finished */
  status: string
  /** Integration id of the draft; null until the agent names a new integration */
  integrationId: string | null
  /** First user message, as a label for sessions not yet named */
  firstMessage: string | null
  /** Model calls made so far */
  steps: number
  /** Last update time (ISO) */
  updatedAt: string
  /** User who started the session; null for sessions created outside a sign-in */
  userId: string | null
  /** True when the session holds work nobody else can see yet (dashboard drafts) */
  unsaved: boolean
  /** What the session is building, once named (a dashboard draft's name) */
  label: string | null
  /** Email of the user who started the session */
  userEmail: string | null
}

/** Draft definition fields the UI cares about (passed through as JSON). */
export interface Definition {
  /** Integration id */
  id: string
  /** Display name (a plain string while a draft has not been saved yet) */
  name: LocalizedString | string
  /** Runtime image id */
  runtime: string
  /** Single-file integration code */
  code: string
  /** Everything else in the definition */
  [key: string]: unknown
}

/** Designer client state mirrored from the server. */
export interface DesignerState {
  /** Draft definition */
  definition: Definition
  /** Cold-run certification, when one passed */
  coldRun: { definitionHash: string; runId: string; files?: Record<string, string> } | null
  /** Most recent test run */
  lastRun: { runId: string; status: string; cold: boolean } | null
  /** True when finish started the fresh install's first production load; absent before finish */
  firstLoadStarted?: boolean
  /** File versions the session works with, per slot */
  files?: Record<string, string> | null
}

/** One declared file slot of a definition. */
export interface FileSlotSpec {
  /** What the file is and must contain */
  description?: LocalizedString | string
  /** Accepted extensions, e.g. [".xlsx"]; absent accepts any */
  accept?: string[]
}

/** Build outcome inside a dashboard session's client state. */
export interface DashboardBuild {
  /** Monotonic build counter; the preview remounts when it changes */
  rev: number
  /** True when the source compiled and typechecked */
  ok: boolean
  /** Compile/typecheck errors when not ok */
  errors: string[]
  /** Compiled ESM for the preview frame */
  bundleJs?: string
  /** Compiled stylesheet for the preview frame */
  bundleCss?: string
}

/** Dashboard-session client state mirrored from the server. */
export interface DashboardAgentState {
  /** Bound dashboard id; empty until the first save names it */
  dashboardId: string
  /** Draft display name */
  name: string
  /** Draft React source */
  source: string
  /** Draft stored queries */
  queries: DashboardQuery[]
  /** Declared raster catalog layer ids */
  layers: string[]
  /** Latest build outcome; null before the first write_source */
  build: DashboardBuild | null
  /** Saved version once the user saved */
  saved: { version: number } | null
  /** True when the draft has changes the saved version (if any) lacks */
  dirty: boolean
  /** Slug and name the agent proposed for the first save; null until it is ready */
  proposed?: { id: string; name: string } | null
}

/** One stored query result of an assistant session; blocks bind to it by id. */
export interface AssistantResult {
  /** The SQL that produced it, shown on block expand */
  sql: string
  /** Column names in result order */
  columns: string[]
  /** Complete result rows (over-cap queries are rejected server-side) */
  rows: Record<string, unknown>[]
}

/** Assistant-session client state mirrored from the server. */
export interface AssistantState {
  /** Stored query results by id ("q1", "q2", ...) */
  results: Record<string, AssistantResult>
  /** Ordinal of the next result id */
  nextResult: number
}

/** Full session detail from GET /api/sessions/:id. */
export interface SessionDetail extends SessionSummary {
  /** Serialized model messages (the transcript) */
  messages: TranscriptMessage[]
  /** Per-kind client state */
  state: DesignerState | DashboardAgentState | AssistantState
  /** Cumulative usage counters */
  usage: { steps: number; inputTokens: number; outputTokens: number } | null
  /** True when the current definition passed a cold run */
  certified: boolean
  /** True while the loop is executing server-side */
  running: boolean
  /** Error that stopped the last loop, if it crashed (cleared on the next step) */
  error: string | null
  /** Scratch preview layers with data, for map links during design */
  scratchLayers: { id: string; name: LocalizedString }[]
  /** True when the session may be deleted (a design session only while no integration carries its id) */
  deletable: boolean
}

/** One content part of a stored model message. */
export interface MessagePart {
  /** Part discriminator: text, tool-call, tool-result, reasoning, ... */
  type: string
  /** Text content when type is "text" */
  text?: string
  /** Tool name for tool-call/tool-result parts */
  toolName?: string
  /** Correlates a tool-call with its tool-result */
  toolCallId?: string
  /** Tool input for tool-call parts */
  input?: unknown
  /** Tool output for tool-result parts */
  output?: { type: string; value: string }
}

/** One stored model message of the transcript. */
export interface TranscriptMessage {
  /** Message author: user, assistant, or tool */
  role: string
  /** Plain text or structured parts */
  content: string | MessagePart[]
}

/** One live event from the session SSE stream. */
export interface SessionEvent {
  /** Event discriminator */
  type: string
  /** Assistant or user text (assistant_text, user_message, stop) */
  text?: string
  /** Tool name (tool_start, tool_end) */
  tool?: string
  /** Tool input (tool_start) */
  input?: unknown
  /** Result prefix (tool_end) */
  summary?: string
  /** Job stderr line (job_log) */
  line?: string
  /** Stop reason (stop) */
  reason?: string
  /** Error message (error) */
  message?: string
  /** Newly bound integration id (integration_bound) */
  integrationId?: string
}

/** Summary row from GET /api/integrations. */
export interface IntegrationSummary {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** What the integration ingests and produces, when the definition has one */
  description: LocalizedString | null
  /** Runtime image id */
  runtime: string
  /** Trigger spec */
  trigger: { cron?: string; webhook?: boolean }
  /** Number of declared destinations */
  destinations: number
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Status of the most recent run */
  lastRunStatus: string | null
  /** Time of the most recent run (ISO) */
  lastRunAt: string | null
}

/** One run in an integration's history. */
export interface RunSummary {
  /** Run id */
  id: string
  /** What triggered it */
  trigger: string
  /** Terminal or current status */
  status: string
  /** Start time (ISO) */
  startedAt: string | null
  /** Finish time (ISO) */
  finishedAt: string | null
  /** Row/snapshot stats recorded on success */
  stats: { rows?: Record<string, number>; snapshots?: number; durationMs?: number } | null
  /** Error message on failure */
  error: string | null
  /** Validation flags the run raised; null when none */
  flags: RunFlag[] | null
}

/** One data-quality finding on a run: values outside a range rule or a column's codes. */
export interface RunFlag {
  /** tableId or layerId */
  destinationId: string
  /** Column id or band id */
  field: string
  /** Which rule raised it */
  rule: "range" | "enum"
  /** One-line description */
  message: string
}

/** Per-destination stored-data stats. */
export interface DestinationStats {
  /** Destination kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Row or snapshot count; null before the first run */
  count: number | null
}

/** Full detail from GET /api/integrations/:id. */
export interface IntegrationDetail {
  /** Integration id */
  id: string
  /** Current definition version */
  version: number
  /** Installed definition */
  definition: Definition
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Install/update time (ISO) */
  updatedAt: string
  /** Recent runs, newest first */
  runs: RunSummary[]
  /** Stored-data stats per destination */
  destinations: DestinationStats[]
}

/** The signed-in user. */
export interface User {
  /** User id */
  id: string
  /** Login email */
  email: string
  /** Role: admin, editor, or viewer */
  role: "admin" | "editor" | "viewer"
}

/** How the deployment's AI features are wired, from /api/me. */
export interface AiInfo {
  /** Configured model provider; "custom" is an admin-run endpoint, null is none */
  provider: "openrouter" | "anthropic" | "custom" | null
  /** Model id in use; null when AI is off */
  model: string | null
  /** True until this user acknowledges the external-provider data notice */
  ackRequired: boolean
}

/** Model provider kinds an admin can choose. */
export type AiProviderKind = "openrouter" | "anthropic" | "custom"

/** The admin view of the AI settings; the key itself never comes back. */
export interface AiSettings {
  /** Provider kind; null when AI is off */
  provider: AiProviderKind | null
  /** Saved model id; null uses the provider default */
  model: string | null
  /** Custom endpoint base URL; null otherwise */
  baseUrl: string | null
  /** True when an API key is saved */
  keySaved: boolean
  /** False when the server has no INTEGRATOR_SECRET_KEY to encrypt keys with */
  canStoreKeys: boolean
  /** Default model per hosted provider */
  defaults: { openrouter: string; anthropic: string }
}

/** Reads the AI settings (admins). */
export function getAiSettings(): Promise<AiSettings> {
  return request("/api/settings/ai")
}

/**
 * Saves the AI provider (admins). The server sends one test request first and
 * refuses settings the provider does not answer. A blank key keeps the saved
 * one when the provider and endpoint are unchanged.
 */
export function saveAiSettings(body: { provider: AiProviderKind; model: string; baseUrl: string; apiKey: string }): Promise<AiSettings> {
  return request("/api/settings/ai", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
}

/** Turns AI off and forgets the saved key (admins). */
export function clearAiSettings(): Promise<AiSettings> {
  return request("/api/settings/ai", { method: "DELETE" })
}

/** Daily AI token caps; null means no cap. */
export interface AiLimits {
  /** Tokens one user's sessions may use per UTC day */
  userDailyTokens: number | null
  /** Tokens all sessions together may use per UTC day */
  deploymentDailyTokens: number | null
}

/** The caps plus the deployment's usage so far today. */
export interface AiLimitsView {
  /** Caps in force */
  limits: AiLimits
  /** Tokens used by everyone since midnight UTC */
  usedToday: number
}

/** Reads the daily AI token caps (admins). */
export function getAiLimits(): Promise<AiLimitsView> {
  return request("/api/settings/ai_limits")
}

/** Saves the daily AI token caps (admins). */
export function saveAiLimits(limits: AiLimits): Promise<AiLimitsView> {
  return request("/api/settings/ai_limits", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(limits)
  })
}

/** Optional password expiry and inactivity disabling; null turns a rule off. */
export interface AccountPolicy {
  /** Days after which a password must be changed at next sign-in */
  passwordMaxAgeDays: number | null
  /** Days without sign-in or API use after which an account is disabled */
  inactiveDisableDays: number | null
}

/** Reads the account policy (admins). */
export async function getAccountPolicy(): Promise<AccountPolicy> {
  return (await request<{ policy: AccountPolicy }>("/api/settings/account_policy")).policy
}

/** Saves the account policy (admins). */
export async function saveAccountPolicy(policy: AccountPolicy): Promise<AccountPolicy> {
  return (await request<{ policy: AccountPolicy }>("/api/settings/account_policy", jsonBody("PUT", policy))).policy
}

/** The /api/me payload: the signed-in user plus the AI wiring. */
export interface Me {
  /** The signed-in user */
  user: User
  /** AI provider and acknowledgement state */
  ai: AiInfo
}

/**
 * Fetches JSON, throwing on HTTP errors with the server's message. A 401 on a
 * data route dispatches "auth:required" so the app can flip to the login screen.
 */
async function request<T>(url: string, init?: RequestInit, quiet401 = false): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !quiet401) window.dispatchEvent(new Event("auth:required"))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return body as T
}

/** The signed-in user with AI wiring, or null when not authenticated. */
export async function getMe(): Promise<Me | null> {
  try {
    return await request<Me>("/api/me", undefined, true)
  } catch {
    return null
  }
}

/** Records the one-time acknowledgement that AI features send data to the provider. */
export function acknowledgeAi(): Promise<{ ok: boolean }> {
  return request("/api/me/ai-acknowledge", { method: "POST" })
}

/** Thrown by login when the password is past the deployment's maximum age. */
export class PasswordExpiredError extends Error {}

/**
 * Signs in; the session rides an httpOnly cookie afterwards. An expired
 * password throws PasswordExpiredError; retry with its replacement as
 * newPassword.
 */
export async function login(email: string, password: string, newPassword?: string): Promise<User> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, ...(newPassword !== undefined ? { newPassword } : {}) })
  })
  const body = (await res.json().catch(() => ({}))) as { user?: User; error?: string; code?: string }
  if (!res.ok) {
    if (body.code === "password_expired") throw new PasswordExpiredError(body.error)
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return body.user!
}

/** Signs out and revokes the session. */
export function logout(): Promise<{ ok: boolean }> {
  return request("/api/logout", { method: "POST" })
}

/** One user as admins manage them. */
export interface AdminUser {
  /** User id */
  id: string
  /** Login email */
  email: string
  /** Role: admin, editor, or viewer */
  role: "admin" | "editor" | "viewer"
  /** Whether sign-in is blocked */
  disabled: boolean
  /** Creation time (ISO) */
  createdAt: string
}

/** JSON request options for a body-carrying method. */
function jsonBody(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

/** Lists all users (admin). */
export function listUsers(): Promise<{ users: AdminUser[] }> {
  return request("/api/users")
}

/** Creates a user; the generated password is returned once (admin). */
export function createUser(email: string, role: AdminUser["role"]): Promise<{ user: AdminUser; password: string }> {
  return request("/api/users", jsonBody("POST", { email, role }))
}

/** Resets a user's password to a fresh generated one, returned once (admin). */
export function resetUserPassword(id: string): Promise<{ password: string }> {
  return request(`/api/users/${id}/password`, { method: "POST" })
}

/** Changes a user's role (admin). */
export function setUserRole(id: string, role: AdminUser["role"]): Promise<{ user: AdminUser }> {
  return request(`/api/users/${id}/role`, jsonBody("PUT", { role }))
}

/** Disables or enables a user (admin). */
export function setUserDisabled(id: string, disabled: boolean): Promise<{ user: AdminUser }> {
  return request(`/api/users/${id}/disabled`, jsonBody("PUT", { disabled }))
}

/** Changes the signed-in user's own password. */
export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request("/api/me/password", jsonBody("POST", { currentPassword, newPassword }))
}

/** One promoted snapshot of a layer (map time axis). */
export interface LayerSnapshot {
  /** Snapshot id (tile URLs pin to it) */
  id: string
  /** Observation time (ISO) */
  observed_at: string
  /** End of the observed period (ISO) for interval layers, else null */
  observed_end: string | null
  /** Number of files in the snapshot; 0 is a published "nothing observed" */
  sources: number
}

/**
 * Cache-busting token for tile URLs, derived from the band's rendering
 * config: tile URLs are served immutable, so restyled bands must change URL
 * or browsers keep the old pixels forever.
 */
export function styleToken(rendering: unknown): string {
  const text = JSON.stringify(rendering ?? {})
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/** One catalog layer as /api/layers reports it. */
export interface MapLayer {
  /** Layer id */
  id: string
  /** Display name */
  name: LocalizedString
  /** current-only or time-series */
  temporality: string
  /** Current snapshot id, null before first data */
  current_snapshot_id: string | null
  /** Observation time of the current snapshot (ISO) */
  observed_at: string | null
  /** Band declarations, rendering config included */
  bands?: LayerBand[]
  /** Envelope of the current snapshot as GeoJSON */
  footprint: { coordinates: number[][][] } | null
  /** Promoted snapshots ascending by time */
  snapshots: LayerSnapshot[]
  /** True when tiles are clipped to the layer's area by default */
  masked?: boolean
  /** Short key of the mask shape, for cache-busting tile URLs; null without a mask */
  mask_key?: string | null
}

/** Lists catalog layers with their snapshots. */
export function listLayers(sessionId?: string): Promise<{ layers: MapLayer[] }> {
  return request(sessionId ? `/api/layers?session=${encodeURIComponent(sessionId)}` : "/api/layers")
}

/** One value-to-color stop of a band's color map. */
export interface BandColorStop {
  /** Pixel value the color is pinned to */
  value: number
  /** CSS color at that value */
  color: string
}

/** How a band draws as map tiles. */
export interface BandRendering {
  /** Value-to-color stops; also the legend */
  colorMap?: BandColorStop[]
  /** Overview resampling */
  resampling?: "nearest" | "average"
}

/** One measured band of a raster layer. */
export interface LayerBand {
  /** Band id, used in tile URLs */
  id: string
  /** Display name; falls back to the id */
  name?: LocalizedString
  /** Measurement units, e.g. "mm/month" */
  units?: string
  /** Value meaning "no data" */
  nodata?: number
  /** Tile rendering config */
  rendering?: BandRendering
}

/** One raster layer in full, from GET /api/layers/:id. */
export interface LayerDetail {
  /** Layer id */
  id: string
  /** Display name */
  name: LocalizedString
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: LocalizedString
  /** current-only or time-series */
  temporality: string
  /** Days of history a time-series layer keeps; null keeps everything */
  retentionDays: number | null
  /** Measured bands, in declaration order */
  bands: LayerBand[]
  /** Current snapshot id, null before first data */
  currentSnapshotId: string | null
  /** Observation time of the current snapshot (ISO) */
  observedAt: string | null
  /** End of the observed period (ISO) for interval layers */
  observedEnd: string | null
  /** CRS of the stored rasters */
  crs: string | null
  /** Lineage the integration attached to the current snapshot (source URLs, product versions) */
  metadata: Record<string, unknown> | null
  /** Envelope of the current snapshot as GeoJSON */
  footprint: { coordinates: number[][][] } | null
  /** Promoted snapshots, ascending by time */
  snapshots: LayerSnapshot[]
  /** Total bytes across promoted snapshots */
  sizeBytes: number
  /** True when tiles are clipped to the layer's area of interest by default */
  masked: boolean
  /** Short key of the mask shape, so tile URLs change when the area does; null without a mask */
  maskKey: string | null
  /** Owning integration's prose description */
  description: LocalizedString | null
  /** Provenance of the external source, if declared */
  source: LayerSource | null
}

/** Provenance block from the owning integration's definition. */
export interface LayerSource {
  /** Source name */
  name: LocalizedString
  /** Primary URL of the source or its API */
  url?: string
  /** Organization publishing the data */
  provider?: string
  /** License of the source data */
  license?: string
  /** Link to source documentation */
  documentation?: string
  /** Known caveats a data consumer should see */
  limitations?: string
}

/** Fetches one raster layer; sessionId scopes to a design session's scratch layers. */
export function getLayer(id: string, sessionId?: string | null): Promise<LayerDetail> {
  return request(`/api/layers/${id}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`)
}

/** One pixel of a layer snapshot, or null outside the raster / at nodata. */
export interface LayerSample {
  /** Measured value; null when the point has no data */
  value: number | null
}

/** Reads the pixel under a WGS84 lon/lat for click-to-inspect. */
export function sampleLayer(
  layerId: string,
  snapshotId: string,
  lon: number,
  lat: number,
  bandId?: string | null,
  sessionId?: string | null
): Promise<LayerSample> {
  const params = new URLSearchParams({
    snapshot: snapshotId,
    lon: String(lon),
    lat: String(lat)
  })
  if (bandId) params.set("band", bandId)
  if (sessionId) params.set("session", sessionId)
  return request(`/api/layers/${layerId}/sample?${params}`)
}

/** One data source in the catalog: a destination table or a raster layer. */
export interface DataSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: LocalizedString
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: LocalizedString
  /** Destination description, falling back to the integration's description */
  description: LocalizedString | null
  /** Row count (tables); null before first run */
  rows: number | null
  /** Declared column count (tables) */
  columns: number | null
  /** Promoted snapshot count (rasters) */
  snapshots: number | null
  /** Latest data time (ISO) */
  updatedAt: string | null
}

/** Lists the data catalog (tables + raster layers), freshest first. */
export function listSources(): Promise<{ sources: DataSource[] }> {
  return request("/api/sources")
}

/** One data source row on the home page. */
export interface HomeSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: LocalizedString
  /** Row count (tables); null for rasters */
  rows: number | null
  /** Declared column count (tables); null for rasters */
  columns: number | null
  /** Promoted snapshot count (rasters); null for tables */
  snapshots: number | null
  /** Latest data time (ISO) */
  updatedAt: string | null
}

/** One integration row on the home page. */
export interface HomeIntegration {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** Whether the scheduler considers it */
  enabled: boolean
  /** Lifecycle: draft until a design session's cold run certifies it */
  status: "draft" | "ready"
  /** Status of the most recent run, if any */
  lastRunStatus: string | null
  /** Time of the most recent run (ISO) */
  lastRunAt: string | null
}

/** An enabled integration whose data needs a look: its latest run raised flags, or it is overdue. */
export interface HomeQualityIssue {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** flagged: the latest successful run raised validation flags; stale: no success within twice its expected cadence */
  kind: "flagged" | "stale"
  /** Flag messages (flagged only) */
  messages: string[]
  /** Latest successful run's finish time (ISO), or null when it never succeeded */
  lastSuccessAt: string | null
}

/** An integration waiting for credentials before it can run. */
export interface HomeCredentialNeed {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** draft (still in a design session) or ready */
  status: string
  /** Declared secret names with no stored value */
  missing: string[]
  /** Paused design session that requested them, when there is one */
  sessionId: string | null
}

/** An enabled integration whose most recent run failed. */
export interface HomeProblem {
  /** Integration id */
  id: string
  /** Display name */
  name: LocalizedString
  /** Terminal status of the failing run */
  status: string
  /** Error recorded on the run */
  error: string | null
  /** When the run failed (ISO) */
  failedAt: string | null
}

/** Headline counts behind the home page's action cards and panel links. */
export interface HomeCounts {
  /** Installed integrations */
  integrations: number
  /** Destination tables holding data */
  tables: number
  /** Raster layers holding data */
  rasters: number
  /** Saved dashboards */
  dashboards: number
  /** Library entries available to install; null when not computed */
  library: number | null
}

/** Which agent-backed features this deployment has a model configured for. */
export interface HomeAi {
  /** Designing and editing integrations with the agent */
  designer: boolean
  /** Building dashboards with the agent */
  dashboards: boolean
  /** The query assistant */
  assistant: boolean
}

/** Everything the home page renders, from GET /api/home. */
export interface HomeSummary {
  /** Deployment display name, already resolved against the default */
  title: string
  /** True once any destination holds data */
  hasData: boolean
  /** Headline counts */
  counts: HomeCounts
  /** Freshest data sources, capped */
  sources: HomeSource[]
  /** Integrations, most recently updated first, capped */
  integrations: HomeIntegration[]
  /** Enabled integrations whose most recent run failed */
  problems: HomeProblem[]
  /** Integrations whose declared credentials are not all stored */
  credentialsNeeded: HomeCredentialNeed[]
  /** Integrations whose latest data raised validation flags or is overdue */
  quality: HomeQualityIssue[]
  /** Agent-backed features available here */
  ai: HomeAi
}

/** Fetches the home page summary. */
export function getHome(): Promise<HomeSummary> {
  return request("/api/home")
}

/** Lists installed integrations. */
export function listIntegrations(): Promise<{ integrations: IntegrationSummary[] }> {
  return request("/api/integrations")
}

/** Where a run went: started now, or queued behind the run in progress. */
export interface RunStart {
  /** Run id */
  runId: string
  /** running, or queued when pinned files had to wait their turn */
  status: "running" | "queued"
}

/** Starts a manual run of an integration; files pins versions per slot (a revert or multi-file replace). */
export function startRun(integrationId: string, files?: Record<string, string>): Promise<RunStart> {
  return request(`/api/integrations/${integrationId}/run`, jsonBody("POST", files ? { files } : {}))
}

/** Starts a rebuild: a cold run with an empty /work and no previous state, producing everything in scope again. */
export function startRebuild(integrationId: string): Promise<RunStart> {
  return request(`/api/integrations/${integrationId}/run`, jsonBody("POST", { rebuild: true }))
}

/** Sets this deployment's setting values; null restores a setting's default. Saving archives a new version. */
export function setIntegrationSettings(
  id: string,
  values: Record<string, SettingValue | null>
): Promise<{ version: number }> {
  return request(`/api/integrations/${id}/settings`, jsonBody("PUT", { values }))
}

/** One uploaded file version as the files API lists it; filename and uploader are null for viewers. */
export interface FileVersionListing {
  /** Version id */
  id: string
  /** Number within the slot */
  version: number
  /** Name it was uploaded under; null for viewers */
  filename: string | null
  /** Uploader email; null for viewers or when unknown */
  uploadedBy: string | null
  /** Upload time (ISO) */
  uploadedAt: string
  /** Size in bytes */
  sizeBytes: number
  /** SHA-256, hex */
  sha256: string
  /** True for the version runs read when they pin nothing */
  current: boolean
  /** Purge time (ISO) when an admin purged the bytes */
  purgedAt: string | null
  /** Runs that read this version, newest first */
  runs: { id: string; status: string; finishedAt: string | null }[]
}

/** One file slot of an integration with its versions. */
export interface FileSlotListing {
  /** Slot id */
  slotId: string
  /** True when the installed definition declares it */
  declared: boolean
  /** Declared description */
  description: LocalizedString | string | null
  /** Declared accept list */
  accept: string[] | null
  /** Bytes held by live versions */
  bytesStored: number
  /** Versions, newest first */
  versions: FileVersionListing[]
}

/** Lists an integration's file slots and versions. */
export function listIntegrationFiles(integrationId: string): Promise<{ slots: FileSlotListing[]; maxUploadMb: number }> {
  return request(`/api/integrations/${integrationId}/files`)
}

/** A stored upload as upload responses return it. */
export interface UploadedVersion {
  /** Version id */
  id: string
  /** Slot it went to */
  slotId: string
  /** Number within the slot */
  version: number
  /** Name it was uploaded under */
  filename: string
  /** Size in bytes */
  sizeBytes: number
}

/** Result of an integration-page upload. */
export interface IntegrationUpload {
  /** The new version */
  version: UploadedVersion
  /** The run it started or queued; null with run=false, or when none could be created */
  run: { id: string; status: "running" | "queued" } | null
  /** Why no run was created, when one was asked for */
  runError?: string
}

/**
 * PUTs a file as a raw body, reporting upload progress (0-1). XMLHttpRequest
 * rather than fetch, which cannot report upload progress. A 413 that is not
 * the server's own JSON came from a proxy in front of it.
 */
function uploadRaw<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("content-type", "application/octet-stream")
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total)
    }
    // A server that refuses an upload early closes the connection mid-body,
    // which the browser reports as a network error, not as the refusal
    xhr.onerror = () =>
      reject(new Error(T`The upload failed: the connection closed. The file may be too large or of a type this slot does not accept.`))
    xhr.onload = () => {
      let body: { error?: string } | null = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as T)
      else if (xhr.status === 401) {
        window.dispatchEvent(new Event("auth:required"))
        reject(new Error(body?.error ?? "HTTP 401"))
      } else if (xhr.status === 413 && !body?.error) {
        reject(
          new Error(
            T`The file is larger than a proxy in front of this server allows. Ask the administrator to raise the proxy's upload limit (Cloudflare allows 100 MB on its Free and Pro plans; nginx needs client_max_body_size).`
          )
        )
      } else reject(new Error(body?.error ?? `HTTP ${xhr.status}`))
    }
    xhr.send(file)
  })
}

/** Uploads a new version of a file slot; with run, starts or queues a run reading it. */
export function uploadIntegrationFile(
  integrationId: string,
  slotId: string,
  file: File,
  run: boolean,
  onProgress?: (fraction: number) => void
): Promise<IntegrationUpload> {
  const query = new URLSearchParams({ filename: file.name, run: String(run) })
  return uploadRaw(`/api/integrations/${integrationId}/files/${slotId}?${query}`, file, onProgress)
}

/** Stages a design-session attachment; the message that carries it pins it. */
export function uploadSessionFile(
  sessionId: string,
  slotId: string,
  file: File,
  onProgress?: (fraction: number) => void
): Promise<{ version: UploadedVersion }> {
  const query = new URLSearchParams({ filename: file.name })
  return uploadRaw(`/api/sessions/${sessionId}/files/${slotId}?${query}`, file, onProgress)
}

/** Download URL of one file version (editors and admins). */
export function fileVersionUrl(integrationId: string, slotId: string, versionId: string): string {
  return `/api/integrations/${integrationId}/files/${slotId}/versions/${versionId}/download`
}

/** Fetches the newest rows of a destination table. */
export function getTableRows(
  integrationId: string,
  tableId: string
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  return request(`/api/integrations/${integrationId}/tables/${tableId}/rows`)
}

/** Fetches one integration's detail. */
export function getIntegration(id: string): Promise<IntegrationDetail> {
  return request(`/api/integrations/${id}`)
}

/** Lists designer sessions. */
export function listSessions(): Promise<{ sessions: SessionSummary[] }> {
  return request("/api/sessions")
}

/** Creates a designer session; without an id the agent names the integration. */
export function createSession(integrationId?: string): Promise<{ sessionId: string }> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: currentLocale(), ...(integrationId ? { integrationId } : {}) })
  })
}

/** Creates a dashboard design session; with an id it edits that dashboard. */
export function createDashboardSession(dashboardId?: string): Promise<{ sessionId: string }> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "dashboard", locale: currentLocale(), ...(dashboardId ? { dashboardId } : {}) })
  })
}

/** Creates an assistant chat session (open to every role). */
export function createAssistantSession(): Promise<{ sessionId: string }> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "assistant", locale: currentLocale() })
  })
}

/** Executes a draft stored query of a dashboard session (design preview). */
export async function execSessionQuery(
  sessionId: string,
  queryName: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const result = await request<{ rows: Record<string, unknown>[] }>(
    `/api/sessions/${sessionId}/queries/${queryName}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params })
    }
  )
  return result.rows
}

/** Fetches one session's detail. */
export function getSession(sessionId: string): Promise<SessionDetail> {
  return request(`/api/sessions/${sessionId}`)
}

/**
 * Saves a dashboard design session's draft as a new version, visible to
 * everyone signed in. id and name apply to the first save only.
 */
export function saveDashboardSession(
  sessionId: string,
  body: { id?: string; name?: string }
): Promise<{ dashboardId: string; version: number }> {
  return request(`/api/sessions/${sessionId}/save`, jsonBody("POST", body))
}

/** Permanently deletes a session: an assistant chat, or a dashboard draft (Discard Changes). */
export function deleteSession(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}`, { method: "DELETE" })
}

/** Requests a graceful stop of a running session (lands at the next step boundary). */
export function stopSession(sessionId: string): Promise<{ stopping: boolean }> {
  return request(`/api/sessions/${sessionId}/stop`, { method: "POST" })
}

/**
 * Sends a user message into a session; while running it queues as steering.
 * files attaches uploads staged with uploadSessionFile (refused while running).
 */
export function sendMessage(
  sessionId: string,
  text: string,
  files: { slot: string; versionId: string }[] = []
): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(files.length > 0 ? { text, files } : { text })
  })
}

/** Subscribes to a session's SSE stream; returns the close function. */
export function subscribeEvents(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events`)
  source.onmessage = message => onEvent(JSON.parse(message.data))
  return () => source.close()
}

/** One declared parameter of a stored dashboard query. */
export interface DashboardQueryParam {
  /** Parameter name */
  name: string
  /** Value type the server validates against */
  type: string
  /** Whether null/absent values are rejected */
  required?: boolean
}

/** One stored query of a dashboard version. */
export interface DashboardQuery {
  /** Name useQuery() calls reference */
  name: string
  /** The frozen SQL */
  sql: string
  /** Declared parameters in positional order */
  params: DashboardQueryParam[]
  /** Row cap for this query, when the default is overridden */
  maxRows?: number
  /** True when the query serves MVT vector tiles instead of rows */
  tile?: boolean
}

/** Summary row from GET /api/dashboards. */
export interface DashboardSummary {
  /** Dashboard id */
  id: string
  /** Display name */
  name: string
  /** Current version number */
  currentVersion: number | null
  /** Last update time (ISO) */
  updatedAt: string
  /** True when viewable without signing in */
  public: boolean
  /** Email of the admin who made it public; null while private */
  publishedBy: string | null
  /** When it was made public (ISO); null while private */
  publishedAt: string | null
}

/** Full detail from GET /api/dashboards/:id (source and queries are omitted for anonymous viewers). */
export interface DashboardDetail extends DashboardSummary {
  /** React source of the current version; absent for anonymous viewers */
  source?: string
  /** Stored queries of the current version; absent for anonymous viewers */
  queries?: DashboardQuery[]
  /** Raster catalog layer ids the version declares */
  layers: string[]
  /** Kit version the bundle was built against; provenance, not a loader input */
  builtWithKit: string
  /** Compiled ESM bundle */
  bundleJs: string
  /** Compiled stylesheet */
  bundleCss: string
}

/** Lists dashboards, newest first. */
export function listDashboards(): Promise<{ dashboards: DashboardSummary[] }> {
  return request("/api/dashboards")
}

/** Fetches one dashboard at its current version. */
export function getDashboard(id: string): Promise<DashboardDetail> {
  return request(`/api/dashboards/${id}`)
}

/** Permanently deletes a dashboard and all its versions; design sessions are kept. */
export function deleteDashboard(id: string): Promise<{ versions: number; sessions: number }> {
  return request(`/api/dashboards/${id}`, { method: "DELETE" })
}

/** Renames a dashboard's slug and/or display name; existing links break with the slug. */
export function renameDashboard(id: string, newId: string, name: string): Promise<{ id: string }> {
  return request(`/api/dashboards/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: newId, name })
  })
}

/** One stored version in a dashboard's history. */
export interface DashboardVersionSummary {
  /** Version number, counting up from 1 */
  version: number
  /** When it was saved (ISO) */
  createdAt: string
  /** Email of the user who saved it; null when not recorded */
  createdBy: string | null
  /** The version this one copied, when it was made by a restore */
  restoredFrom: number | null
}

/** A dashboard's version history, newest first. */
export function getDashboardVersions(id: string): Promise<{ versions: DashboardVersionSummary[] }> {
  return request(`/api/dashboards/${id}/versions`)
}

/** Restores an earlier version by saving a copy of it as the new current version. */
export function restoreDashboardVersion(id: string, version: number): Promise<{ version: number }> {
  return request(`/api/dashboards/${id}/versions/${version}/restore`, { method: "POST" })
}

/** Opens or closes a dashboard's view surface to unauthenticated viewers. */
export function setDashboardPublic(id: string, isPublic: boolean): Promise<{ public: boolean }> {
  return request(`/api/dashboards/${id}/public`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public: isPublic })
  })
}

/** One declared layer in a dashboard's freshness meta. */
export interface DashboardLayerMeta {
  /** Layer id */
  id: string
  /** Display name */
  name: LocalizedString
  /** static or time-series */
  temporality: string
  /** Snapshot drawn when none is picked */
  currentSnapshotId: string | null
  /** Promoted snapshots, oldest first */
  snapshots: { id: string; observedAt: string; observedEnd: string | null }[]
  /** Short key of the mask shape, so tile URLs change when the area does; null without a mask */
  maskKey: string | null
}

/** Freshness and declared-layer meta the dashboard frame mounts with. */
export interface DashboardMeta {
  /** Table id to last-update time */
  tables: Record<string, string | null>
  /** Declared raster layers with snapshot timelines */
  layers: DashboardLayerMeta[]
}

/** Fetches the frame meta for one dashboard (public for public dashboards). */
export function getDashboardMeta(id: string): Promise<DashboardMeta> {
  return request(`/api/dashboards/${id}/meta`)
}

/** One catalog source a dashboard reads, for the viewer's Sources list. */
export interface DashboardSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: LocalizedString
  /** Catalog description */
  description: LocalizedString | null
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: LocalizedString
  /** Last data update (ISO); null before the first run */
  updatedAt: string | null
}

/** Lists the tables and layers a dashboard reads (public for public dashboards). */
export function getDashboardSources(id: string): Promise<{ sources: DashboardSource[] }> {
  return request(`/api/dashboards/${id}/sources`)
}

/** What an integration owns and what would break with it. */
export interface IntegrationUsage {
  /** Owned destination table ids */
  tables: string[]
  /** Owned raster layer ids */
  layers: string[]
  /** Installed integrations whose inputs read this one's data */
  dependents: { id: string; via: string }[]
  /** Dashboards whose queries appear to reference the owned data */
  dashboards: { id: string; name: string }[]
  /** Total recorded runs */
  runs: number
}

/** Reports an integration's owned data and its dependents, for the delete dialog. */
export function getIntegrationUsage(id: string): Promise<IntegrationUsage> {
  return request(`/api/integrations/${id}/usage`)
}

/**
 * Permanently deletes an integration with everything it owns (tables, rasters,
 * files, run history); design sessions are kept. 409s while runs are active or
 * dependents exist.
 */
export function deleteIntegration(id: string): Promise<{ tables: number; snapshots: number; runs: number }> {
  return request(`/api/integrations/${id}`, { method: "DELETE" })
}

/** Executes a stored dashboard query with named parameter values. */
export async function execDashboardQuery(
  dashboardId: string,
  queryName: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const result = await request<{ rows: Record<string, unknown>[] }>(
    `/api/dashboards/${dashboardId}/queries/${queryName}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params })
    }
  )
  return result.rows
}

/** One selectable country from the baked-in list (Natural Earth derived). */
export interface CountryBox {
  /** ISO 3166-1 alpha-3 */
  iso3: string
  /** Display name */
  name: string
  /** [west, south, east, north], EPSG:4326; west > east crosses the antimeridian */
  bbox: [number, number, number, number]
}

/** Deployment default area of interest. */
export interface DefaultAoi {
  /** [west, south, east, north], EPSG:4326 */
  bbox: [number, number, number, number]
  /** ISO3 codes covered by the box, for country-keyed sources */
  countries?: string[]
  /** Display label of the selection (e.g. the country name) */
  name?: string
}

/** The baked-in country list for AOI pickers. */
export function listCountries(): Promise<{ countries: CountryBox[] }> {
  return request("/api/countries")
}

/** State of the background data-catalog translation pass. */
export interface CatalogTranslation {
  /** True while a pass is running */
  running: boolean
  /** Locales the running or last pass targeted */
  locales: string[]
  /** Start time of the running or last pass (ISO); null when never run */
  startedAt: string | null
  /** Finish time of the last pass (ISO); null while running or never run */
  finishedAt: string | null
  /** Result of the last pass; null while running or never run */
  result: { integrations: number; translations: number; failures: string[] } | null
}

/** Deployment settings. */
export function getSettings(): Promise<{
  settings: { default_aoi: DefaultAoi | null; site_title: string | null; locales: string[] }
  supportedLocales: { code: string; name: string }[]
  catalogTranslation: CatalogTranslation
}> {
  return request("/api/settings")
}

/**
 * Sets the deployment's offered locales (admin only). Adding a language starts
 * a background translation of the data catalog into it; poll getSettings.
 */
export function setLocalesSetting(
  locales: string[]
): Promise<{ locales: string[]; added: string[]; catalogTranslation: CatalogTranslation }> {
  return request("/api/settings/locales", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locales })
  })
}

/** Sets the deployment display name; a blank title restores the default (admin only). */
export function setSiteTitle(title: string): Promise<{ site_title: string | null }> {
  return request("/api/settings/site_title", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  })
}

/** Sets the deployment default AOI (admin only). */
export function setDefaultAoi(aoi: DefaultAoi): Promise<{ default_aoi: DefaultAoi }> {
  return request("/api/settings/default_aoi", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(aoi)
  })
}

/** Clears the deployment default AOI (admin only). */
export function clearDefaultAoi(): Promise<{ default_aoi: null }> {
  return request("/api/settings/default_aoi", { method: "DELETE" })
}

/** How a definition version answers the area-of-interest question. */
export type AoiMode = "inherit" | "full" | "box"

/** One archived definition version. */
export interface VersionSummary {
  /** Version number, counting up from 1 */
  version: number
  /** Archive time (ISO) */
  createdAt: string
  /** Email of the installing user; null for CLI/library-sync installs */
  createdBy: string | null
  /** Display name in this version */
  name: string
  /** AOI tri-state in this version */
  aoiMode: AoiMode
  /** The explicit box, when aoiMode is "box" */
  aoi: { bbox: [number, number, number, number]; countries?: string[] } | null
}

/** The integration's version history, newest first. */
export function getIntegrationVersions(id: string): Promise<{ versions: VersionSummary[] }> {
  return request(`/api/integrations/${id}/versions`)
}

/** Changes the integration's display name, archiving a new definition version. */
export function renameIntegration(id: string, name: string): Promise<{ version: number; name: LocalizedString }> {
  return request(`/api/integrations/${id}/name`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, locale: currentLocale() })
  })
}

/** Changes the integration's AOI, archiving a new definition version. */
export function setIntegrationAoi(
  id: string,
  body: { mode: "inherit" | "full" } | { mode: "box"; aoi: { bbox: [number, number, number, number]; countries?: string[] } }
): Promise<{ version: number }> {
  return request(`/api/integrations/${id}/aoi`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
}

/** One library entry with its relationship to this deployment. */
export interface LibraryEntry {
  /** Entry id (= integration id when installed) */
  id: string
  /** Display name */
  name: LocalizedString
  /** What the integration does */
  description: LocalizedString | null
  /** Source provenance */
  source: { name?: LocalizedString; provider?: string; license?: string; url?: string } | null
  /** Suggested cadence */
  trigger: { cron?: string; webhook?: boolean }
  /** Runtime image id */
  runtime: string
  /** Declared destinations */
  destinations: { kind: string; id: string }[]
  /** Relationship to this deployment */
  status: "not_installed" | "installed" | "update_available"
  /** Installed version, when installed */
  installedVersion: number | null
}

/** The browsable library with per-entry install status. */
export function listLibrary(): Promise<{ entries: LibraryEntry[] }> {
  return request("/api/library")
}

/** One skill in the library index: source and technique know-how. */
export interface SkillSummary {
  /** Directory name under library/skills */
  id: string
  /** Display name */
  name: string
  /** One-liner describing what it covers */
  description: string
  /** Date the skill was last checked against the live source, when recorded */
  verified: string | null
}

/** One skill's readable content. */
export interface SkillDetail extends SkillSummary {
  /** Markdown body, frontmatter removed */
  body: string
}

/** Lists the library's skills; empty when the deployment has no library. */
export function listSkills(): Promise<{ skills: SkillSummary[] }> {
  return request("/api/skills")
}

/** Fetches one skill's full text. */
export function getSkill(id: string): Promise<SkillDetail> {
  return request(`/api/skills/${id}`)
}

/** One declared destination of a library entry, as the expanded row shows it. */
export type LibraryDestination =
  | {
      /** Table destination */
      kind: "table"
      /** Destination table id */
      tableId: string
      /** Display name */
      name?: LocalizedString
      /** What the table contains */
      description?: LocalizedString
      /** Declared columns */
      columns: TableColumn[]
    }
  | {
      /** Raster destination */
      kind: "raster"
      /** Destination layer id */
      layerId: string
      /** Display name */
      name?: LocalizedString
      /** What the layer shows */
      description?: LocalizedString
      /** Time-series or current-only */
      temporality: string
      /** Declared bands */
      bands: { id: string; name?: LocalizedString; units?: string }[]
    }

/** A library entry's definition with the fields the Library page expands, code elided. */
export interface LibraryDefinition {
  /** Entry id */
  id: string
  /** Source provenance */
  source?: {
    name: LocalizedString
    url?: string
    provider?: string
    license?: string
    documentation?: string
    limitations?: LocalizedString
  }
  /** Declared destinations */
  destinations: LibraryDestination[]
  /** Runtime image id */
  runtime: string
  /** Everything else in the definition */
  [key: string]: unknown
}

/** A library entry's full definition, code elided. */
export function getLibraryEntry(id: string): Promise<{ definition: LibraryDefinition }> {
  return request(`/api/library/${id}`)
}

/** Installs or updates a library entry; optionally starts the first ingest. */
export function installLibraryEntry(id: string, runNow: boolean): Promise<{ version: number; runId: string | null }> {
  return request(`/api/library/${id}/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runNow })
  })
}

/** Geometry facts of a destination table, for the map view. */
export function getTableGeometry(
  tableId: string
): Promise<{ geometryColumn: string | null; extent: [number, number, number, number] | null }> {
  return request(`/api/tables/${tableId}/geometry`)
}

/** Declared column of a destination table, from its spec. */
export interface TableColumn {
  /** Column id (SQL name) */
  id: string
  /** Display name */
  name?: LocalizedString
  /** Column type */
  type: string
  /** Units of measure */
  units?: string
}

/** One queryable table with its declared schema, from GET /api/tables. */
export interface TableSchema {
  /** Table id */
  tableId: string
  /** Integration that writes it */
  integrationId: string
  /** Display name from the destination spec */
  name?: LocalizedString
  /** Catalog description from the destination spec */
  description?: LocalizedString
  /** Declared column specs */
  columns: TableColumn[]
}

/** Lists the queryable tables with their declared schemas. */
export function listTableSchemas(): Promise<{ tables: TableSchema[] }> {
  return request("/api/tables")
}

/** Imports a shared integration definition; it installs paused. */
export function importIntegration(definition: unknown): Promise<{ id: string; version: number }> {
  return request("/api/integrations/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition)
  })
}

/** Reads the webhook capability URL parts (editor or admin). */
export function getWebhookToken(id: string): Promise<{ token: string; path: string }> {
  return request(`/api/integrations/${id}/webhook-token`)
}

/** Rotates the webhook token, invalidating the old URL (admin only). */
export function rotateWebhookToken(id: string): Promise<{ token: string; path: string }> {
  return request(`/api/integrations/${id}/webhook-token`, { method: "POST" })
}

/** Changes the schedule (definition content: archives a new version). */
export function setIntegrationTrigger(
  id: string,
  trigger: { cron?: string | null; webhook?: boolean; webhookDelaySeconds?: number }
): Promise<{ version: number; trigger: { cron?: string; webhook?: boolean; webhookDelaySeconds?: number } }> {
  return request(`/api/integrations/${id}/trigger`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(trigger)
  })
}

/** Enables or pauses scheduling (operational state, not versioned). */
export function setIntegrationEnabled(id: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return request(`/api/integrations/${id}/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled })
  })
}

/** A stored secret's name and last update; values are write-only. */
export interface SecretInfo {
  /** The name the definition references */
  name: string
  /** Owning integration */
  integrationId: string
  /** Last set or replaced, ISO 8601 */
  updatedAt: string
}

/** Lists one integration's stored secret names (editors and admins). */
export function listIntegrationSecrets(integrationId: string): Promise<{ secrets: SecretInfo[] }> {
  return request(`/api/integrations/${integrationId}/secrets`)
}

/** Lists every integration's stored secret names (admin only). */
export function listAllSecrets(): Promise<{ secrets: SecretInfo[] }> {
  return request("/api/secrets")
}

/** Sets or replaces one integration's secret value (admin only). */
export function setSecretValue(integrationId: string, name: string, value: string): Promise<{ name: string }> {
  return request(`/api/integrations/${integrationId}/secrets/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value })
  })
}

/** Copies a secret value from another integration server-side (admin only). */
export function copySecretValue(integrationId: string, name: string, fromIntegrationId: string): Promise<{ name: string }> {
  return request(`/api/integrations/${integrationId}/secrets/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ copyFrom: fromIntegrationId })
  })
}

/** Deletes one integration's secret (admin only). */
export function deleteSecretValue(integrationId: string, name: string): Promise<{ deleted: string }> {
  return request(`/api/integrations/${integrationId}/secrets/${name}`, { method: "DELETE" })
}

/** Runs the agent's check snippet for one requested credential of a design session. */
export function checkSessionSecret(sessionId: string, name: string): Promise<{ ok: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/secrets/${name}/check`, { method: "POST" })
}

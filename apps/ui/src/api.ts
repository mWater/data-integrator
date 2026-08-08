/** Session summary row from GET /api/sessions. */
export interface SessionSummary {
  /** Session id */
  id: string
  /** Session kind: designer or dashboard */
  kind: "designer" | "dashboard"
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
}

/** Draft definition fields the UI cares about (passed through as JSON). */
export interface Definition {
  /** Integration id */
  id: string
  /** Display name */
  name: string
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
  coldRun: { definitionHash: string; runId: string } | null
  /** Most recent test run */
  lastRun: { runId: string; status: string; cold: boolean } | null
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
  /** Bound dashboard id; empty until finish names it */
  dashboardId: string
  /** Draft display name */
  name: string
  /** Draft React source */
  source: string
  /** Draft stored queries */
  queries: DashboardQuery[]
  /** Latest build outcome; null before the first write_source */
  build: DashboardBuild | null
  /** Saved version once finish succeeded */
  saved: { version: number } | null
}

/** Full session detail from GET /api/sessions/:id. */
export interface SessionDetail extends SessionSummary {
  /** Serialized model messages (the transcript) */
  messages: TranscriptMessage[]
  /** Per-kind client state */
  state: DesignerState | DashboardAgentState
  /** Cumulative usage counters */
  usage: { steps: number; inputTokens: number; outputTokens: number } | null
  /** True when the current definition passed a cold run */
  certified: boolean
  /** True while the loop is executing server-side */
  running: boolean
  /** Error that stopped the last loop, if it crashed (cleared on the next step) */
  error: string | null
  /** Scratch preview layers with data, for map links during design */
  scratchLayers: { id: string; name: string }[]
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
  name: string
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
  /** Installed definition */
  definition: Definition
  /** Deployment overrides */
  overrides: unknown
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
  /** Login email */
  email: string
  /** Role: admin, editor, or viewer */
  role: "admin" | "editor" | "viewer"
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

/** The signed-in user, or null when not authenticated. */
export async function getMe(): Promise<User | null> {
  try {
    return (await request<{ user: User }>("/api/me", undefined, true)).user
  } catch {
    return null
  }
}

/** Signs in; the session rides an httpOnly cookie afterwards. */
export async function login(email: string, password: string): Promise<User> {
  const result = await request<{ user: User }>(
    "/api/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    },
    true
  )
  return result.user
}

/** Signs out and revokes the session. */
export function logout(): Promise<{ ok: boolean }> {
  return request("/api/logout", { method: "POST" })
}

/** One promoted snapshot of a layer (map time axis). */
export interface LayerSnapshot {
  /** Snapshot id (tile URLs pin to it) */
  id: string
  /** Observation time (ISO) */
  observed_at: string
}

/** One catalog layer as /layers reports it. */
export interface MapLayer {
  /** Layer id */
  id: string
  /** Display name */
  name: string
  /** current-only or time-series */
  temporality: string
  /** Current snapshot id, null before first data */
  current_snapshot_id: string | null
  /** Observation time of the current snapshot (ISO) */
  observed_at: string | null
  /** Envelope of the current snapshot as GeoJSON */
  footprint: { coordinates: number[][][] } | null
  /** Promoted snapshots ascending by time */
  snapshots: LayerSnapshot[]
}

/** Lists catalog layers with their snapshots. */
export function listLayers(sessionId?: string): Promise<{ layers: MapLayer[] }> {
  return request(sessionId ? `/layers?session=${encodeURIComponent(sessionId)}` : "/layers")
}

/** One data source in the catalog: a destination table or a raster layer. */
export interface DataSource {
  /** Source kind */
  kind: "table" | "raster"
  /** tableId or layerId */
  id: string
  /** Display name */
  name: string
  /** Owning integration id */
  integrationId: string
  /** Owning integration display name */
  integrationName: string
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

/** Lists installed integrations. */
export function listIntegrations(): Promise<{ integrations: IntegrationSummary[] }> {
  return request("/api/integrations")
}

/** Starts a manual run of an integration. */
export function startRun(integrationId: string): Promise<{ runId: string }> {
  return request(`/api/integrations/${integrationId}/run`, { method: "POST" })
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
    body: JSON.stringify(integrationId ? { integrationId } : {})
  })
}

/** Creates a dashboard design session; with an id it edits that dashboard. */
export function createDashboardSession(dashboardId?: string): Promise<{ sessionId: string }> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "dashboard", ...(dashboardId ? { dashboardId } : {}) })
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

/** Requests a graceful stop of a running session (lands at the next step boundary). */
export function stopSession(sessionId: string): Promise<{ stopping: boolean }> {
  return request(`/api/sessions/${sessionId}/stop`, { method: "POST" })
}

/** Sends a user message into a session; while running it queues as steering. */
export function sendMessage(sessionId: string, text: string): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
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
}

/** Full detail from GET /api/dashboards/:id. */
export interface DashboardDetail extends DashboardSummary {
  /** React source of the current version */
  source: string
  /** Stored queries of the current version */
  queries: DashboardQuery[]
  /** Kit version the bundle is pinned to */
  kitVersion: string
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

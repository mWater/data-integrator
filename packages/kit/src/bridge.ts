/**
 * postMessage bridge between the sandboxed dashboard frame and its host page.
 * The frame has an opaque origin and no credentials: every query, tile byte,
 * and error report crosses this bridge, and the host executes with the
 * viewer's session against per-dashboard-authorized endpoints.
 */

import type { ThemeTokens } from "./theme.js"

/** One row of a stored-query result. */
export type Row = Record<string, unknown>

/** Freshness / lineage metadata the host supplies for "data as of" displays. */
export interface DashboardMeta {
  /** Per-table latest successful ingest time (ISO 8601), keyed by table id. */
  tables: Record<string, string | null>
}

/** Props the host resolves and sends to the frame at mount. */
export interface FrameInit {
  /** BCP 47 locale for number/date formatting. */
  locale: string
  /** Resolved theme tokens for the active color mode. */
  theme: ThemeTokens
  /** Filter/UI state restored from the host URL, if any. */
  initialState?: unknown
  /** Freshness metadata snapshot. */
  meta: DashboardMeta
}

/** Messages sent frame → host. */
export type FrameMessage =
  | { type: "di:ready" }
  | { type: "di:query"; id: number; name: string; params: Record<string, unknown> }
  | { type: "di:tile"; id: number; layerId: string; z: number; x: number; y: number }
  | { type: "di:error"; message: string; stack?: string }
  | { type: "di:state"; state: unknown }
  | { type: "di:resize"; height: number }

/** Messages sent host → frame. */
export type HostMessage =
  | { type: "di:init"; init: FrameInit }
  | { type: "di:query-result"; id: number; ok: boolean; rows?: Row[]; error?: string }
  | { type: "di:tile-result"; id: number; ok: boolean; data?: ArrayBuffer; error?: string }

interface Pending {
  /** Resolves the request with the message payload. */
  resolve: (msg: HostMessage) => void
  /** Rejects on bridge teardown. */
  reject: (err: Error) => void
}

let nextId = 1
const pending = new Map<number, Pending>()
let initResolve: ((init: FrameInit) => void) | null = null

/** Resolved once the host sends di:init. */
export const frameInit: Promise<FrameInit> = new Promise((resolve) => {
  initResolve = resolve
})

function post(msg: FrameMessage, transfer?: Transferable[]): void {
  window.parent.postMessage(msg, "*", transfer)
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return
  const msg = event.data as HostMessage
  if (!msg || typeof msg !== "object") return
  if (msg.type === "di:init") {
    initResolve?.(msg.init)
    return
  }
  if (msg.type === "di:query-result" || msg.type === "di:tile-result") {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.resolve(msg)
    }
  }
}

/** Installs the frame-side listener and announces readiness. Called once by mountDashboard. */
export function connectBridge(): void {
  window.addEventListener("message", onMessage)
  post({ type: "di:ready" })
}

/** Executes a stored query by name through the host. */
export function bridgeQuery(name: string, params: Record<string, unknown>): Promise<Row[]> {
  const id = nextId++
  return new Promise<Row[]>((resolve, reject) => {
    pending.set(id, {
      resolve: (msg) => {
        if (msg.type !== "di:query-result") return
        if (msg.ok) resolve(msg.rows ?? [])
        else reject(new Error(msg.error ?? "query failed"))
      },
      reject
    })
    post({ type: "di:query", id, name, params })
  })
}

/** Fetches raster tile bytes through the host (MapLibre custom protocol). */
export function bridgeTile(layerId: string, z: number, x: number, y: number): Promise<ArrayBuffer> {
  const id = nextId++
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, {
      resolve: (msg) => {
        if (msg.type !== "di:tile-result") return
        if (msg.ok && msg.data) resolve(msg.data)
        else reject(new Error(msg.error ?? "tile fetch failed"))
      },
      reject
    })
    post({ type: "di:tile", id, layerId, z, x, y })
  })
}

/** Reports a runtime error to the host (surfaced to the design session or viewer). */
export function bridgeError(message: string, stack?: string): void {
  post({ type: "di:error", message, stack })
}

/** Reports dashboard UI state for host-side deep-link persistence. */
export function bridgeState(state: unknown): void {
  post({ type: "di:state", state })
}

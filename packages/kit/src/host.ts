/**
 * Host-side frame mounting: builds the sandboxed srcdoc iframe for a compiled
 * dashboard and services its bridge requests with the host's credentials.
 * Imported by the app UI (never by dashboard code).
 */

import type { FrameInit, FrameMessage, HostMessage, Row } from "./bridge.js"

// Theme tokens re-exported for hosts, so importing them (e.g. to pass into
// KitTheme or mountDashboardFrame) does not pull the component barrel and its
// chart/map bundle weight into the host's eager chunk.
export { lightTheme, darkTheme } from "./theme.js"
export type { ThemeTokens } from "./theme.js"

/** Host callbacks that service frame requests using the viewer's session. */
export interface FrameHandlers {
  /** Executes a stored query by name with typed parameter values. */
  runQuery(name: string, params: Record<string, unknown>): Promise<Row[]>
  /** Fetches raster tile bytes for a catalog layer; snapshotId pins one observation, mask false draws beyond the layer's area. */
  fetchTile(layerId: string, z: number, x: number, y: number, snapshotId?: string, mask?: boolean): Promise<ArrayBuffer>
  /** Fetches vector tile bytes of a stored tile query. */
  fetchVectorTile?(
    query: string,
    z: number,
    x: number,
    y: number,
    params: Record<string, unknown>
  ): Promise<ArrayBuffer>
  /** Fetches a basemap resource by relative path; absent means no basemap. */
  fetchBasemap?(path: string): Promise<ArrayBuffer>
  /** Called when the frame reports a runtime error. */
  onError?(message: string, stack?: string): void
  /** Called when the dashboard reports UI state for deep links. */
  onStateChange?(state: unknown): void
}

/** Options for mounting a dashboard frame. */
export interface DashboardFrameOptions {
  /** Element the iframe is appended to; the iframe fills it. */
  container: HTMLElement
  /** Compiled dashboard ESM (bundle_js). */
  bundleJs: string
  /** Compiled dashboard stylesheet (bundle_css). */
  bundleCss: string
  /** Absolute base path of the kit runtime assets, e.g. "/kit/1". */
  kitBase: string
  /** Resolved init payload sent on handshake. */
  init: FrameInit
  /** Request handlers. */
  handlers: FrameHandlers
}

/** A mounted dashboard frame. */
export interface DashboardFrame {
  /** The sandboxed iframe element. */
  iframe: HTMLIFrameElement
  /** Opens the browser print dialog on the dashboard document itself. */
  print(): void
  /** Detaches listeners and removes the iframe. */
  destroy(): void
}

function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script")
}

function frameHtml(opts: DashboardFrameOptions): string {
  const origin = window.location.origin
  const base = origin + opts.kitBase
  const importMap = JSON.stringify({
    imports: {
      react: `${base}/react.js`,
      "react/jsx-runtime": `${base}/jsx-runtime.js`,
      "react-dom/client": `${base}/react-dom-client.js`,
      "@kit/ui": `${base}/kit.js`
    }
  })
  const csp = [
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline' blob:`,
    "worker-src blob:",
    `style-src ${origin} 'unsafe-inline'`,
    "img-src data: blob:",
    // Same-origin only, and the frame carries no credentials: this reaches
    // public assets (MapLibre fetches its worker script), never data
    `connect-src ${origin}`
  ].join("; ")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<script type="importmap">${importMap}</script>
<link rel="stylesheet" href="${base}/kit.css">
<style>${opts.bundleCss}</style>
</head>
<body>
<div id="root"></div>
<script>
// The frame is sandboxed without same-origin access, so the host cannot call
// print on it; it asks, and the frame prints its own full document
window.addEventListener("message", function (e) {
  if (e.source === window.parent && e.data && e.data.type === "di:print") window.print()
})
</script>
<script type="module">${escapeInlineScript(opts.bundleJs)}</script>
</body>
</html>`
}

/** Mounts a compiled dashboard in a sandboxed iframe and services its bridge. */
export function mountDashboardFrame(opts: DashboardFrameOptions): DashboardFrame {
  const iframe = document.createElement("iframe")
  // allow-modals is what lets the frame call print() on itself (browsers
  // ignore it otherwise); it grants nothing beyond alert/confirm/prompt
  iframe.setAttribute("sandbox", "allow-scripts allow-modals")
  iframe.style.width = "100%"
  iframe.style.height = "100%"
  iframe.style.border = "0"
  iframe.srcdoc = frameHtml(opts)

  const post = (msg: HostMessage, transfer?: Transferable[]) => {
    iframe.contentWindow?.postMessage(msg, "*", transfer ?? [])
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return
    const msg = event.data as FrameMessage
    if (!msg || typeof msg !== "object") return
    switch (msg.type) {
      case "di:ready":
        post({ type: "di:init", init: opts.init })
        break
      case "di:query":
        opts.handlers.runQuery(msg.name, msg.params).then(
          (rows) => post({ type: "di:query-result", id: msg.id, ok: true, rows }),
          (err: Error) => post({ type: "di:query-result", id: msg.id, ok: false, error: err.message })
        )
        break
      case "di:tile":
        opts.handlers.fetchTile(msg.layerId, msg.z, msg.x, msg.y, msg.snapshotId, msg.mask).then(
          (data) => post({ type: "di:tile-result", id: msg.id, ok: true, data }, [data]),
          (err: Error) => post({ type: "di:tile-result", id: msg.id, ok: false, error: err.message })
        )
        break
      case "di:vtile":
        if (opts.handlers.fetchVectorTile) {
          opts.handlers.fetchVectorTile(msg.query, msg.z, msg.x, msg.y, msg.params).then(
            (data) => post({ type: "di:vtile-result", id: msg.id, ok: true, data }, [data]),
            (err: Error) => post({ type: "di:vtile-result", id: msg.id, ok: false, error: err.message })
          )
        } else {
          post({ type: "di:vtile-result", id: msg.id, ok: false, error: "vector tiles unavailable" })
        }
        break
      case "di:basemap":
        if (opts.handlers.fetchBasemap) {
          opts.handlers.fetchBasemap(msg.path).then(
            (data) => post({ type: "di:basemap-result", id: msg.id, ok: true, data }, [data]),
            (err: Error) => post({ type: "di:basemap-result", id: msg.id, ok: false, error: err.message })
          )
        } else {
          post({ type: "di:basemap-result", id: msg.id, ok: false, error: "basemap unavailable" })
        }
        break
      case "di:error":
        opts.handlers.onError?.(msg.message, msg.stack)
        break
      case "di:state":
        opts.handlers.onStateChange?.(msg.state)
        break
    }
  }

  window.addEventListener("message", onMessage)
  opts.container.appendChild(iframe)
  return {
    iframe,
    print() {
      iframe.contentWindow?.postMessage({ type: "di:print" }, "*")
    },
    destroy() {
      window.removeEventListener("message", onMessage)
      iframe.remove()
    }
  }
}

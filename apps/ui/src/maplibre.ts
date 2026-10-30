/**
 * Shared MapLibre setup for the app's maps. Import this module before
 * constructing any Map.
 *
 * - MapLibre 6 locates its web worker with a runtime-computed URL that
 *   survives bundling as a bare /assets/maplibre-gl-worker.mjs request,
 *   which does not exist in the built app. Point it at a worker chunk Vite
 *   actually emits.
 * - The server proxies the themed basemap (style, sprites, glyphs, tiles)
 *   at /basemap/*, rewriting internal URLs to the di-basemap:// scheme;
 *   register the protocol handler that resolves them back through the proxy.
 */
import { addProtocol, setWorkerUrl } from "maplibre-gl"
import type { StyleSpecification } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

setWorkerUrl(workerUrl)

addProtocol("di-basemap", async params => {
  const path = params.url.replace(/^di-basemap:\/\//, "")
  const res = await fetch(`/basemap/${path}`)
  if (!res.ok) throw new Error(`basemap ${res.status}`)
  if (params.type === "json") return { data: await res.json() }
  return { data: await res.arrayBuffer() }
})

/** Plain-raster fallback when the basemap proxy is disabled or unreachable. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "(c) OpenStreetMap contributors"
    }
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }]
}

const styleCache = new Map<string, Promise<StyleSpecification>>()

/**
 * The basemap style for a color mode: the same proxied vector style the
 * dashboards use, falling back to raw OSM tiles when the proxy is off.
 */
export function basemapStyle(mode: "light" | "dark"): Promise<StyleSpecification> {
  let cached = styleCache.get(mode)
  if (!cached) {
    cached = fetch(`/basemap/style/${mode}`)
      .then(res => (res.ok ? (res.json() as Promise<StyleSpecification>) : FALLBACK_STYLE))
      .catch(() => FALLBACK_STYLE)
    styleCache.set(mode, cached)
  }
  return cached
}

/**
 * Map view: basemap plus catalog raster layers and GeoJSON overlays. All bytes
 * come through the bridge (the frame has no credentials or network): catalog
 * tiles via a MapLibre custom protocol, basemap style/sprites/glyphs/tiles via
 * a second protocol backed by the host's caching proxy. When the basemap is
 * unavailable (offline, disabled), the map degrades to a plain background.
 */

import { useEffect, useRef } from "react"
import * as maplibregl from "maplibre-gl"
import { bridgeBasemap, bridgeTile } from "../bridge.js"
import { useTheme } from "../hooks.js"
import type { ThemeTokens } from "../theme.js"

let protocolsRegistered = false

function registerProtocols(): void {
  if (protocolsRegistered) return
  protocolsRegistered = true
  // The frame's opaque origin blocks module workers, so route MapLibre to the
  // classic worker bundle beside kit.js (.cjs suffix selects the classic path)
  maplibregl.setWorkerUrl(new URL("./maplibre-worker.cjs", import.meta.url).href)
  // di-tile://<layerId>/<z>/<x>/<y>
  maplibregl.addProtocol("di-tile", async (params: maplibregl.RequestParameters) => {
    const [, layerId, z, x, y] = /^di-tile:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url) ?? []
    if (!layerId) throw new Error(`bad tile url: ${params.url}`)
    const data = await bridgeTile(layerId, Number(z), Number(x), Number(y))
    return { data }
  })
  // di-basemap://<path> — style JSON rewrites its internal URLs to this scheme
  maplibregl.addProtocol("di-basemap", async (params: maplibregl.RequestParameters) => {
    const path = params.url.replace(/^di-basemap:\/\//, "")
    const data = await bridgeBasemap(path)
    if (params.type === "json") return { data: JSON.parse(new TextDecoder().decode(data)) }
    return { data }
  })
}

/** GeoJSON geometry (minimal structural type; matches the GeoJSON spec). */
export interface GeoJsonGeometry {
  /** Geometry type. */
  type: "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon"
  /** Nested coordinate arrays per the geometry type. */
  coordinates: unknown[]
}

/** GeoJSON feature. */
export interface GeoJsonFeature {
  /** Always "Feature". */
  type: "Feature"
  /** Feature geometry; null features are skipped. */
  geometry: GeoJsonGeometry | null
  /** Feature properties; a "color" property overrides the overlay color. */
  properties: Record<string, unknown> | null
}

/** GeoJSON feature collection. */
export interface GeoJsonFeatureCollection {
  /** Always "FeatureCollection". */
  type: "FeatureCollection"
  /** Member features. */
  features: GeoJsonFeature[]
}

/** One GeoJSON overlay drawn on the map. */
export interface GeoJsonOverlay {
  /** Features to draw. */
  data: GeoJsonFeatureCollection
  /** Default color; a feature's "color" property wins. Defaults to series slot 0. */
  color?: string
  /** Polygon fill opacity (default 0.25). */
  fillOpacity?: number
  /** Circle radius in pixels for point features (default 6). */
  radius?: number
  /** Property name shown in a popup when a feature is clicked. */
  popup?: string
}

/** One raster layer to display. */
export interface MapLayer {
  /** Raster catalog layer id; the host resolves the current snapshot. */
  layerId: string
  /** Layer opacity, 0-1. */
  opacity?: number
}

/** Props for the map view. */
export interface MapViewProps {
  /** Raster catalog layers, drawn in order above the basemap. */
  layers?: MapLayer[]
  /** GeoJSON overlays, drawn above raster layers. */
  geojson?: GeoJsonOverlay[]
  /** Initial center as [longitude, latitude]; optional when fit is set. */
  center?: [number, number]
  /** Initial zoom level; optional when fit is set. */
  zoom?: number
  /** Fit the viewport to the GeoJSON overlays instead of center/zoom. */
  fit?: boolean
  /** Pixel height of the map. */
  height?: number
}

/** Fallback style when the basemap proxy is unreachable: plain background. */
function fallbackStyle(theme: ThemeTokens): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": theme.mode === "dark" ? "#101418" : "#e8ecef" }
      }
    ]
  }
}

/** Walks GeoJSON coordinates, extending bounds with every position. */
function extendBounds(bounds: maplibregl.LngLatBounds, coords: unknown): void {
  if (!Array.isArray(coords)) return
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    bounds.extend([coords[0], coords[1]])
    return
  }
  for (const inner of coords) extendBounds(bounds, inner)
}

function overlayBounds(overlays: GeoJsonOverlay[]): maplibregl.LngLatBounds | null {
  const bounds = new maplibregl.LngLatBounds()
  for (const overlay of overlays) {
    for (const feature of overlay.data.features) {
      if (feature.geometry) extendBounds(bounds, feature.geometry.coordinates)
    }
  }
  return bounds.isEmpty() ? null : bounds
}

function addOverlays(map: maplibregl.Map, overlays: GeoJsonOverlay[], theme: ThemeTokens): void {
  overlays.forEach((overlay, i) => {
    const id = `di-geojson-${i}`
    const color: unknown = ["coalesce", ["get", "color"], overlay.color ?? theme.series[0]]
    map.addSource(id, {
      type: "geojson",
      data: overlay.data as unknown as maplibregl.GeoJSONSourceSpecification["data"]
    })
    map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: id,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": color as never, "fill-opacity": overlay.fillOpacity ?? 0.25 }
    })
    map.addLayer({
      id: `${id}-line`,
      type: "line",
      source: id,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]]],
      paint: { "line-color": color as never, "line-width": 2 }
    })
    map.addLayer({
      id: `${id}-circle`,
      type: "circle",
      source: id,
      filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
      paint: {
        "circle-color": color as never,
        "circle-radius": overlay.radius ?? 6,
        "circle-stroke-color": theme.surface,
        "circle-stroke-width": 2
      }
    })
    if (overlay.popup) {
      const property = overlay.popup
      for (const layerId of [`${id}-circle`, `${id}-fill`]) {
        map.on("click", layerId, (e) => {
          const feature = e.features?.[0]
          const value = feature?.properties?.[property]
          if (value == null) return
          new maplibregl.Popup({ closeButton: false })
            .setLngLat(e.lngLat)
            .setText(String(value))
            .addTo(map)
        })
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer"
        })
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = ""
        })
      }
    }
  })
}

/** Interactive map: basemap, catalog raster layers, and GeoJSON overlays. */
export function MapView({ layers, geojson, center, zoom, fit, height }: MapViewProps) {
  const theme = useTheme()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!el.current) return
    registerProtocols()
    let cancelled = false

    const mount = async () => {
      // Host-proxied basemap style; plain background when unavailable
      let style: maplibregl.StyleSpecification | string = fallbackStyle(theme)
      let hasBasemap = false
      try {
        const bytes = await bridgeBasemap(`style/${theme.mode}`)
        style = JSON.parse(new TextDecoder().decode(bytes)) as maplibregl.StyleSpecification
        hasBasemap = true
      } catch {
        // offline or basemap disabled: fall back silently
      }
      if (cancelled || !el.current) return

      const instance = new maplibregl.Map({
        container: el.current,
        style,
        center: center ?? [0, 0],
        zoom: zoom ?? 1,
        // OSM-derived basemaps require visible attribution
        attributionControl: hasBasemap ? { compact: true } : false
      })
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }))
      // Surface resource failures in devtools; MapLibre swallows them otherwise
      instance.on("error", (e) => console.error("[MapView]", String(e.error?.message ?? e.error)))
      instance.on("load", () => {
        for (const layer of layers ?? []) {
          instance.addSource(layer.layerId, {
            type: "raster",
            tiles: [`di-tile://${layer.layerId}/{z}/{x}/{y}`],
            tileSize: 256
          })
          instance.addLayer({
            id: layer.layerId,
            type: "raster",
            source: layer.layerId,
            paint: { "raster-opacity": layer.opacity ?? 0.85 }
          })
        }
        if (geojson) addOverlays(instance, geojson, theme)
        if (fit && geojson) {
          const bounds = overlayBounds(geojson)
          if (bounds) instance.fitBounds(bounds, { padding: 40, maxZoom: 13, duration: 0 })
        }
      })
      map.current = instance
    }
    void mount()

    return () => {
      cancelled = true
      map.current?.remove()
      map.current = null
    }
    // Data/viewport changes rebuild the map; dashboards re-mount rather than mutate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(layers), JSON.stringify(geojson), JSON.stringify(center), zoom, fit, theme.mode])

  return <div ref={el} style={{ height: height ?? 380 }} />
}

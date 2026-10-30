/**
 * Map view: basemap plus catalog raster layers and GeoJSON overlays. All bytes
 * come through the bridge (the frame has no credentials or network): catalog
 * tiles via a MapLibre custom protocol, basemap style/sprites/glyphs/tiles via
 * a second protocol backed by the host's caching proxy. When the basemap is
 * unavailable (offline, disabled), the map degrades to a plain background.
 */

import { useCallback, useEffect, useRef } from "react"
import * as maplibregl from "maplibre-gl"
import { bridgeBasemap, bridgeTile, bridgeVectorTile } from "../bridge.js"
import { useTheme } from "../hooks.js"
import type { ThemeTokens } from "../theme.js"

let protocolsRegistered = false

function registerProtocols(): void {
  if (protocolsRegistered) return
  protocolsRegistered = true
  // The frame's opaque origin blocks module workers, so route MapLibre to the
  // classic worker bundle beside kit.js (.cjs suffix selects the classic path)
  maplibregl.setWorkerUrl(new URL("./maplibre-worker.cjs", import.meta.url).href)
  // di-tile://<layerId>/<snapshotId|current>/<z>/<x>/<y>[?mask=0]
  maplibregl.addProtocol("di-tile", async (params: maplibregl.RequestParameters) => {
    const [, layerId, snapshot, z, x, y, query] =
      /^di-tile:\/\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\?(.*))?$/.exec(params.url) ?? []
    if (!layerId) throw new Error(`bad tile url: ${params.url}`)
    const mask = !(query ?? "").split("&").includes("mask=0")
    const data = await bridgeTile(
      layerId,
      Number(z),
      Number(x),
      Number(y),
      snapshot === "current" ? undefined : snapshot,
      mask
    )
    return { data }
  })
  // di-vtile://<queryName>/<z>/<x>/<y>?params=<urlencoded json>
  maplibregl.addProtocol("di-vtile", async (params: maplibregl.RequestParameters) => {
    const [, query, z, x, y, encoded] =
      /^di-vtile:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\?params=(.*))?$/.exec(params.url) ?? []
    if (!query) throw new Error(`bad vector tile url: ${params.url}`)
    const values = encoded ? (JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>) : {}
    const data = await bridgeVectorTile(query, Number(z), Number(x), Number(y), values)
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
  /** Legend entry text; without it the overlay stays out of the legend. */
  label?: string
}

/** One value-to-color stop of a raster legend, mirroring the layer's rendering colorMap. */
export interface RasterLegendStop {
  /** Band value at this stop. */
  value: number
  /** Hex color at this stop. */
  color: string
  /** Text shown instead of the numeric value. */
  label?: string
}

/** One raster layer to display. */
export interface MapLayer {
  /** Raster catalog layer id; the host resolves the current snapshot. */
  layerId: string
  /**
   * Draw this snapshot instead of the layer's current one, for date-driven
   * maps (sliders, month pickers). Get ids from useLayers().
   */
  snapshotId?: string
  /** Layer opacity, 0-1. */
  opacity?: number
  /**
   * Clip the drawing to the layer's area of interest (default true). Set
   * false to show everything the layer holds, including surroundings the
   * integration fetched beyond the area.
   */
  mask?: boolean
  /** Legend title; defaults to the layer id when colorMap is given. */
  label?: string
  /** Legend color stops (mirror the catalog layer's rendering colorMap); without it the layer stays out of the legend. */
  colorMap?: RasterLegendStop[]
}

/** Data-driven color: distinct color per value of a feature attribute. */
export interface CategoricalColorScale {
  /** Discriminator. */
  kind: "categorical"
  /** Tile attribute matched against values. */
  property: string
  /** Attribute value to color pairs; a label replaces the raw value in the legend. */
  values: { value: string | number; color: string; label?: string }[]
  /** Color for unmatched values; defaults to the layer's base color. */
  otherwise?: string
}

/** Data-driven color: continuous ramp over a numeric feature attribute. */
export interface RampColorScale {
  /** Discriminator. */
  kind: "ramp"
  /** Numeric tile attribute the ramp interpolates over. */
  property: string
  /** Ramp stops in ascending value order; colors interpolate between them. */
  stops: { value: number; color: string }[]
}

/** Data-driven color scale for a vector tile layer. */
export type ColorScale = CategoricalColorScale | RampColorScale

/** Data-driven circle radius over a numeric attribute (e.g. aggregated counts). */
export interface RadiusScale {
  /** Numeric tile attribute the radius interpolates over. */
  property: string
  /** Stops in ascending value order; radii (pixels) interpolate between them. */
  stops: { value: number; radius: number }[]
}

/**
 * One vector tile layer, drawn from a stored tile query. The server encodes
 * MVT tiles per viewport tile, so layers scale to millions of features; only
 * the visible tiles' bytes reach the browser.
 */
export interface VectorTileLayer {
  /** Stored tile query name (a query saved with tile: true). */
  query: string
  /** Values for the query's declared parameters (the zoom param is server-bound). */
  params?: Record<string, unknown>
  /** Base color; defaults to a series slot by layer order. */
  color?: string
  /** Data-driven color; wins over color where it matches. */
  colorBy?: ColorScale
  /** Circle radius in pixels for point features (default 6). */
  radius?: number
  /** Data-driven circle radius; wins over radius. */
  radiusBy?: RadiusScale
  /** Polygon fill opacity (default 0.25). */
  fillOpacity?: number
  /** Tile attribute shown in a popup when a feature is clicked. */
  popup?: string
  /** Hide the layer below this zoom level. */
  minzoom?: number
  /** Hide the layer at and above this zoom level. */
  maxzoom?: number
  /** Legend title; also enables a single swatch entry when no colorBy is set. */
  label?: string
}

/** A clicked point, as longitude and latitude. */
export interface LngLat {
  /** Longitude in degrees. */
  lng: number
  /** Latitude in degrees. */
  lat: number
}

/** A feature click, delivered to onFeatureClick. */
export interface MapFeatureClick {
  /** Which kind of layer was clicked. */
  source: "vector" | "geojson"
  /** Vector layers report their query name; overlays report their label, or overlay-<index> without one. */
  layer: string
  /** The clicked feature's properties: for vector layers, its tile attributes. */
  properties: Record<string, unknown>
  /** Where the click landed. */
  lngLat: LngLat
}

/** Props for the map view. */
export interface MapViewProps {
  /** Raster catalog layers, drawn in order above the basemap. */
  layers?: MapLayer[]
  /** Vector tile layers (stored tile queries), drawn above raster layers. */
  vector?: VectorTileLayer[]
  /** GeoJSON overlays, drawn above vector and raster layers. */
  geojson?: GeoJsonOverlay[]
  /** Initial center as [longitude, latitude]; optional when fit is set. */
  center?: [number, number]
  /** Initial zoom level; optional when fit is set. */
  zoom?: number
  /**
   * Fit the viewport to the GeoJSON overlays instead of center/zoom. Vector
   * tile bounds are unknown client-side, so vector-only maps need center/zoom.
   */
  fit?: boolean
  /** Pixel height of the map. */
  height?: number
  /** Set false to hide the legend; by default it shows when any layer declares legend info. */
  legend?: boolean
  /**
   * Called when a vector tile or GeoJSON feature is clicked, for opening a
   * modal, driving a selection, or filtering the rest of the dashboard. Works
   * alongside a layer's popup rather than replacing it.
   */
  onFeatureClick?: (event: MapFeatureClick) => void
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

/**
 * Wires clicks on the given layers: the pointer cursor, an optional popup, and
 * an optional handler. Both are independent, so a map can show a popup, open a
 * modal, or do both from one click.
 */
function wireClicks(
  map: maplibregl.Map,
  layerIds: string[],
  options: { popup?: string; onClick?: (properties: Record<string, unknown>, lngLat: LngLat) => void }
): void {
  for (const layerId of layerIds) {
    map.on("click", layerId, (e) => {
      const feature = e.features?.[0]
      if (!feature) return
      const properties = (feature.properties ?? {}) as Record<string, unknown>
      if (options.popup) {
        const value = properties[options.popup]
        if (value != null) {
          new maplibregl.Popup({ closeButton: false })
            .setLngLat(e.lngLat)
            .setText(String(value))
            .addTo(map)
        }
      }
      options.onClick?.(properties, { lng: e.lngLat.lng, lat: e.lngLat.lat })
    })
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = ""
    })
  }
}

/** MapLibre color expression for a vector layer: scale if given, else base. */
function colorExpression(layer: VectorTileLayer, fallback: string): unknown {
  const base = layer.color ?? fallback
  const scale = layer.colorBy
  if (!scale) return base
  if (scale.kind === "categorical") {
    if (scale.values.length === 0) return scale.otherwise ?? base
    const expr: unknown[] = ["match", ["get", scale.property]]
    for (const entry of scale.values) expr.push(entry.value, entry.color)
    expr.push(scale.otherwise ?? base)
    return expr
  }
  const stops = [...scale.stops].sort((a, b) => a.value - b.value)
  if (stops.length === 0) return base
  if (stops.length === 1) return stops[0].color
  const expr: unknown[] = ["interpolate", ["linear"], ["to-number", ["get", scale.property]]]
  for (const stop of stops) expr.push(stop.value, stop.color)
  return expr
}

/** MapLibre circle-radius expression: scale if given, else fixed radius. */
function radiusExpression(layer: VectorTileLayer): unknown {
  const scale = layer.radiusBy
  if (!scale || scale.stops.length === 0) return layer.radius ?? 6
  const stops = [...scale.stops].sort((a, b) => a.value - b.value)
  if (stops.length === 1) return stops[0].radius
  const expr: unknown[] = ["interpolate", ["linear"], ["to-number", ["get", scale.property]]]
  for (const stop of stops) expr.push(stop.value, stop.radius)
  return expr
}

/** One rendered legend block: discrete swatch rows or a continuous ramp bar. */
interface LegendBlock {
  /** Block heading; omitted for single-swatch blocks whose row carries the text. */
  title?: string
  /** Discrete color + text rows. */
  swatches?: { color: string; label: string }[]
  /** Ascending stops rendered as a gradient bar with end labels. */
  ramp?: { value: number; color: string }[]
}

/** Compact number for legend labels. */
function legendNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

/** Derives legend blocks from everything the layers declare. */
function legendBlocks(
  layers: MapLayer[],
  vector: VectorTileLayer[],
  geojson: GeoJsonOverlay[],
  theme: ThemeTokens
): LegendBlock[] {
  const blocks: LegendBlock[] = []
  for (const layer of layers) {
    if (!layer.colorMap || layer.colorMap.length === 0) continue
    const stops = [...layer.colorMap].sort((a, b) => a.value - b.value)
    const title = layer.label ?? layer.layerId
    if (stops.length === 1 || stops.some(s => s.label)) {
      blocks.push({ title, swatches: stops.map(s => ({ color: s.color, label: s.label ?? legendNumber(s.value) })) })
    } else {
      blocks.push({ title, ramp: stops })
    }
  }
  vector.forEach((layer, i) => {
    const scale = layer.colorBy
    const title = layer.label ?? layer.query
    if (scale?.kind === "categorical" && scale.values.length > 0) {
      blocks.push({ title, swatches: scale.values.map(v => ({ color: v.color, label: v.label ?? String(v.value) })) })
    } else if (scale?.kind === "ramp" && scale.stops.length > 1) {
      blocks.push({ title, ramp: [...scale.stops].sort((a, b) => a.value - b.value) })
    } else if (layer.label) {
      blocks.push({ swatches: [{ color: layer.color ?? theme.series[i % theme.series.length], label: layer.label }] })
    }
  })
  for (const overlay of geojson) {
    if (overlay.label) blocks.push({ swatches: [{ color: overlay.color ?? theme.series[0], label: overlay.label }] })
  }
  return blocks
}

/** CSS gradient stop list over ascending ramp stops, positioned by value. */
function rampGradient(stops: { value: number; color: string }[]): string {
  const min = stops[0].value
  const span = stops[stops.length - 1].value - min || 1
  return stops.map(s => `${s.color} ${((s.value - min) / span) * 100}%`).join(", ")
}

/** Props for the legend overlay. */
interface MapLegendProps {
  /** Blocks to render. */
  blocks: LegendBlock[]
  /** Resolved theme tokens. */
  theme: ThemeTokens
}

/** Legend overlay: a bottom-left card listing each layer's colors. */
function MapLegend({ blocks, theme }: MapLegendProps) {
  return (
    <div
      className="rounded px-2.5 py-2 text-xs shadow-sm"
      style={{
        position: "absolute",
        left: 8,
        bottom: 8,
        zIndex: 10,
        maxWidth: "55%",
        background: theme.surface,
        color: theme.inkPrimary,
        border: `1px solid ${theme.border}`
      }}
    >
      {blocks.map((block, i) => (
        <div key={i} className={i > 0 ? "mt-2" : undefined}>
          {block.title && (
            <div className="mb-1 font-medium" style={{ color: theme.inkSecondary }}>{block.title}</div>
          )}
          {block.swatches?.map((row, j) => (
            <div key={j} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: row.color }} />
              <span>{row.label}</span>
            </div>
          ))}
          {block.ramp && (
            <div>
              <div
                className="h-2 w-36 rounded-sm"
                style={{ background: `linear-gradient(to right, ${rampGradient(block.ramp)})` }}
              />
              <div className="flex justify-between" style={{ color: theme.inkMuted }}>
                <span>{legendNumber(block.ramp[0].value)}</span>
                <span>{legendNumber(block.ramp[block.ramp.length - 1].value)}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function addVectorLayers(
  map: maplibregl.Map,
  vector: VectorTileLayer[],
  theme: ThemeTokens,
  onFeatureClick?: (event: MapFeatureClick) => void
): void {
  vector.forEach((layer, i) => {
    const id = `di-vtile-${i}`
    const params = encodeURIComponent(JSON.stringify(layer.params ?? {}))
    map.addSource(id, {
      type: "vector",
      tiles: [`di-vtile://${layer.query}/{z}/{x}/{y}?params=${params}`]
    })
    const color = colorExpression(layer, theme.series[i % theme.series.length])
    const zoomRange = {
      ...(layer.minzoom != null ? { minzoom: layer.minzoom } : {}),
      ...(layer.maxzoom != null ? { maxzoom: layer.maxzoom } : {})
    }
    // The server encodes each tile query's features under a layer named after
    // the query, so source-layer is always the query name
    map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: id,
      "source-layer": layer.query,
      ...zoomRange,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": color as never, "fill-opacity": layer.fillOpacity ?? 0.25 }
    })
    map.addLayer({
      id: `${id}-line`,
      type: "line",
      source: id,
      "source-layer": layer.query,
      ...zoomRange,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]]],
      paint: { "line-color": color as never, "line-width": 2 }
    })
    map.addLayer({
      id: `${id}-circle`,
      type: "circle",
      source: id,
      "source-layer": layer.query,
      ...zoomRange,
      filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
      paint: {
        "circle-color": color as never,
        "circle-radius": radiusExpression(layer) as never,
        "circle-stroke-color": theme.surface,
        "circle-stroke-width": 1
      }
    })
    // Wired whenever either is asked for: the cursor and handler are useful
    // without a popup, and vice versa
    if (layer.popup || onFeatureClick) {
      wireClicks(map, [`${id}-circle`, `${id}-fill`], {
        popup: layer.popup,
        onClick: onFeatureClick
          ? (properties, lngLat) =>
              onFeatureClick({ source: "vector", layer: layer.query, properties, lngLat })
          : undefined
      })
    }
  })
}

function addOverlays(
  map: maplibregl.Map,
  overlays: GeoJsonOverlay[],
  theme: ThemeTokens,
  onFeatureClick?: (event: MapFeatureClick) => void
): void {
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
    if (overlay.popup || onFeatureClick) {
      wireClicks(map, [`${id}-circle`, `${id}-fill`], {
        popup: overlay.popup,
        onClick: onFeatureClick
          ? (properties, lngLat) =>
              onFeatureClick({ source: "geojson", layer: overlay.label ?? `overlay-${i}`, properties, lngLat })
          : undefined
      })
    }
  })
}

/** Interactive map: basemap, raster layers, vector tile layers, GeoJSON overlays, legend. */
export function MapView({
  layers,
  vector,
  geojson,
  center,
  zoom,
  fit,
  height,
  legend,
  onFeatureClick
}: MapViewProps) {
  const theme = useTheme()
  // Read through a ref so a fresh handler identity each render does not tear
  // down and rebuild the map; only gaining or losing a handler rewires it
  const clickRef = useRef(onFeatureClick)
  clickRef.current = onFeatureClick
  const hasClick = onFeatureClick !== undefined
  const emitClick = useCallback((event: MapFeatureClick) => clickRef.current?.(event), [])
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
        // Source ids are positional, not layer ids: the same catalog layer can
        // appear twice at different snapshots (e.g. comparing two months)
        ;(layers ?? []).forEach((layer, i) => {
          const id = `di-raster-${i}`
          instance.addSource(id, {
            type: "raster",
            tiles: [
              `di-tile://${layer.layerId}/${layer.snapshotId ?? "current"}/{z}/{x}/{y}${layer.mask === false ? "?mask=0" : ""}`
            ],
            tileSize: 256
          })
          instance.addLayer({
            id,
            type: "raster",
            source: id,
            paint: { "raster-opacity": layer.opacity ?? 0.85 }
          })
        })
        if (vector) addVectorLayers(instance, vector, theme, hasClick ? emitClick : undefined)
        if (geojson) addOverlays(instance, geojson, theme, hasClick ? emitClick : undefined)
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
  }, [JSON.stringify(layers), JSON.stringify(vector), JSON.stringify(geojson), JSON.stringify(center), zoom, fit, theme.mode, hasClick, emitClick])

  const blocks = legend === false ? [] : legendBlocks(layers ?? [], vector ?? [], geojson ?? [], theme)
  // Positioning is inline: MapLibre's stylesheet (appended after the Tailwind
  // utilities in kit.css) resets the container's position and would override
  // utility classes, collapsing the map to zero height
  return (
    <div
      style={{
        position: "relative",
        height: height ?? 380,
        // Popups mount into the map container, so the theme reaches MapLibre's
        // own stylesheet (kit.css) through these custom properties
        ["--kit-popup-bg" as string]: theme.surface,
        ["--kit-popup-ink" as string]: theme.inkPrimary,
        ["--kit-popup-border" as string]: theme.border,
        ["--kit-popup-muted" as string]: theme.inkMuted
      }}
    >
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {blocks.length > 0 && <MapLegend blocks={blocks} theme={theme} />}
    </div>
  )
}

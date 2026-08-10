/**
 * Map block: catalog raster layers plus GeoJSON overlays built from a stored
 * query result's rows, on the host's own maplibre (credentialed tile URLs, no
 * frame bridge). Overlay painting mirrors the kit MapView so assistant maps
 * and dashboard maps read the same.
 */

import { useEffect, useRef, useState } from "react"
import { GeoJSONSourceSpecification, LngLatBounds, Map as MapLibreMap, Popup } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useTheme, type GeoJsonFeature, type GeoJsonFeatureCollection, type GeoJsonGeometry } from "@data-integrator/kit"
import { AssistantResult, listLayers, MapLayer } from "../api.js"
import { BlockShell } from "./BlockShell.js"
import { ShowMapInput, ShowMapOverlay } from "./types.js"

/** Tile URL for a layer pinned to one snapshot. */
const tileUrl = (layerId: string, snapshotId: string) => `/tiles/${layerId}/${snapshotId}/{z}/{x}/{y}.png`

/** One overlay resolved to a FeatureCollection. */
interface ResolvedOverlay {
  /** Feature collection built from the result rows */
  data: GeoJsonFeatureCollection
  /** Overlay color; theme series slot 0 when absent */
  color?: string
  /** Property shown on click */
  popup?: string
  /** Legend title */
  label?: string
}

/** Builds a FeatureCollection from a result's rows per the overlay declaration. */
function resolveOverlay(overlay: ShowMapOverlay, result: AssistantResult): ResolvedOverlay {
  const features: GeoJsonFeature[] = []
  for (const row of result.rows) {
    let geometry: GeoJsonGeometry | null = null
    if (overlay.geojsonColumn) {
      const cell = row[overlay.geojsonColumn]
      try {
        const parsed = typeof cell === "string" ? JSON.parse(cell) : cell
        if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
          geometry = parsed as GeoJsonGeometry
        }
      } catch {
        // Unparseable rows are skipped rather than sinking the map
      }
    } else if (overlay.lonColumn && overlay.latColumn) {
      const lon = row[overlay.lonColumn]
      const lat = row[overlay.latColumn]
      if (typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)) {
        geometry = { type: "Point", coordinates: [lon, lat] }
      }
    }
    if (!geometry) continue
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (key !== overlay.geojsonColumn) properties[key] = value
    }
    features.push({ type: "Feature", geometry, properties })
  }
  return { data: { type: "FeatureCollection", features }, color: overlay.color, popup: overlay.popup, label: overlay.label }
}

/** Walks GeoJSON coordinates, extending bounds with every position. */
function extendBounds(bounds: LngLatBounds, coords: unknown): void {
  if (!Array.isArray(coords)) return
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    bounds.extend([coords[0], coords[1]])
    return
  }
  for (const inner of coords) extendBounds(bounds, inner)
}

/** Bounds over all overlay features, or null when empty. */
function overlayBounds(overlays: ResolvedOverlay[]): LngLatBounds | null {
  const bounds = new LngLatBounds()
  for (const overlay of overlays) {
    for (const feature of overlay.data.features) {
      if (feature.geometry && "coordinates" in feature.geometry) extendBounds(bounds, feature.geometry.coordinates)
    }
  }
  return bounds.isEmpty() ? null : bounds
}

/** Click popup + pointer cursor on the given layers, showing one property. */
function wirePopup(map: MapLibreMap, layerIds: string[], property: string): void {
  for (const layerId of layerIds) {
    map.on("click", layerId, e => {
      const value = e.features?.[0]?.properties?.[property]
      if (value == null) return
      new Popup({ closeButton: false }).setLngLat(e.lngLat).setText(String(value)).addTo(map)
    })
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = ""
    })
  }
}

/**
 * Snapshot drawn for a layer: the one covering the requested date, else the
 * layer's current snapshot. Null when the layer has no data at all.
 */
function resolveSnapshot(layer: MapLayer, at?: string): string | null {
  if (at) {
    const covering = [...layer.snapshots]
      .reverse()
      .find(s => s.observed_at.slice(0, 10) <= at && (s.observed_end == null || at <= s.observed_end.slice(0, 10)))
    if (covering) return covering.id
  }
  return layer.current_snapshot_id
}

/** Props for a map block. */
interface MapBlockProps {
  /** The show_map tool input */
  spec: ShowMapInput
  /** Stored results referenced by the spec's overlays */
  results: Record<string, AssistantResult>
}

/** Renders one map block: basemap, pinned raster tiles, overlays, legend. */
export function MapBlock({ spec, results }: MapBlockProps) {
  const theme = useTheme()
  const container = useRef<HTMLDivElement>(null)
  const [catalog, setCatalog] = useState<MapLayer[] | null>(null)

  useEffect(() => {
    let cancelled = false
    if ((spec.layers ?? []).length === 0) {
      setCatalog([])
      return
    }
    listLayers().then(
      ({ layers }) => {
        if (!cancelled) setCatalog(layers)
      },
      () => {
        if (!cancelled) setCatalog([])
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!container.current || catalog === null) return
    const overlays = (spec.overlays ?? [])
      .filter(o => results[o.resultId])
      .map(o => resolveOverlay(o, results[o.resultId]))
    const map = new MapLibreMap({
      container: container.current,
      style: {
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
      },
      center: [30, -10],
      zoom: 3
    })

    map.on("load", () => {
      for (const layer of spec.layers ?? []) {
        const entry = catalog.find(l => l.id === layer.layerId)
        const snapshotId = entry ? resolveSnapshot(entry, layer.at) : null
        if (!snapshotId) continue
        map.addSource(layer.layerId, { type: "raster", tiles: [tileUrl(layer.layerId, snapshotId)], tileSize: 256 })
        map.addLayer({
          id: layer.layerId,
          type: "raster",
          source: layer.layerId,
          paint: { "raster-opacity": layer.opacity ?? 0.8 }
        })
      }
      overlays.forEach((overlay, i) => {
        const id = `block-geojson-${i}`
        const color: unknown = ["coalesce", ["get", "color"], overlay.color || theme.series[0]]
        map.addSource(id, { type: "geojson", data: overlay.data as unknown as GeoJSONSourceSpecification["data"] })
        map.addLayer({
          id: `${id}-fill`,
          type: "fill",
          source: id,
          filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
          paint: { "fill-color": color as never, "fill-opacity": 0.25 }
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
            "circle-radius": 6,
            "circle-stroke-color": theme.surface,
            "circle-stroke-width": 2
          }
        })
        if (overlay.popup) wirePopup(map, [`${id}-circle`, `${id}-fill`], overlay.popup)
      })

      const bounds = spec.fit === false ? null : overlayBounds(overlays)
      if (bounds) map.fitBounds(bounds, { padding: 40, maxZoom: 12 })
      else {
        const first = (spec.layers ?? []).map(l => catalog.find(c => c.id === l.layerId)).find(l => l?.footprint)
        if (first?.footprint) {
          const fb = new LngLatBounds()
          for (const point of first.footprint.coordinates[0]) fb.extend(point as [number, number])
          if (!fb.isEmpty()) map.fitBounds(fb, { padding: 40 })
        }
      }
    })

    return () => map.remove()
    // The spec and results are frozen per block; catalog arrival triggers the build
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, theme])

  const legend = [
    ...(spec.layers ?? []).filter(l => l.label).map(l => ({ label: l.label!, color: null as string | null })),
    ...(spec.overlays ?? []).filter(o => o.label).map(o => ({ label: o.label!, color: o.color || theme.series[0] }))
  ]
  const sqls = [...new Set((spec.overlays ?? []).map(o => results[o.resultId]?.sql).filter(Boolean))]
  return (
    <BlockShell title={spec.title} sql={sqls.length > 0 ? sqls.join("\n\n") : undefined}>
      <div className="block-map">
        <div ref={container} className="block-map-canvas" />
        {legend.length > 0 && (
          <div className="block-legend">
            {legend.map(entry => (
              <div key={entry.label} className="block-legend-row">
                {entry.color && <span className="block-legend-swatch" style={{ background: entry.color }} />}
                {entry.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </BlockShell>
  )
}

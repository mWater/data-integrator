/**
 * Map view of one destination table: MVT vector tiles straight off the
 * table's geometry column, with click popups listing the feature's
 * properties. Loaded lazily so maplibre stays out of the first paint.
 */
import { useEffect, useRef } from "react"
import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { basemapStyle } from "./maplibre.js"
import { useAppTheme } from "./theme.js"

/** MVT layer name the server encodes table tiles under. */
const SOURCE_LAYER = "features"

/** Props for the table map. */
interface TableMapProps {
  /** Table whose tiles are drawn */
  tableId: string
  /** [west, south, east, north] to frame initially; null centers on nothing in particular */
  extent: [number, number, number, number] | null
  /** Localized display name per column id, for popup row labels */
  columnLabels?: Record<string, string>
}

/** Renders the table's features over the basemap with property popups. */
export function TableMap({ tableId, extent, columnLabels }: TableMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const { mode } = useAppTheme()

  // Labels can arrive after the map mounts; the click handler reads the ref
  // so popups always use the latest ones without rebuilding the map
  const labelsRef = useRef(columnLabels)
  labelsRef.current = columnLabels

  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false
    void basemapStyle(mode).then(style => {
      if (cancelled || !containerRef.current) return
      const map = new MapLibreMap({
        container: containerRef.current,
        style,
        center: [30, -10],
        zoom: 3
      })
      map.addControl(new NavigationControl({ showCompass: false }))
      mapRef.current = map
      map.on("load", () => {
        map.addSource("table", {
          type: "vector",
          tiles: [`${location.origin}/api/tables/${tableId}/tiles/{z}/{x}/{y}.mvt`]
        })
        map.addLayer({
          id: "table-fill",
          type: "fill",
          source: "table",
          "source-layer": SOURCE_LAYER,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": "#2171b5", "fill-opacity": 0.15 }
        })
        map.addLayer({
          id: "table-outline",
          type: "line",
          source: "table",
          "source-layer": SOURCE_LAYER,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "line-color": "#2171b5", "line-width": 1 }
        })
        map.addLayer({
          id: "table-line",
          type: "line",
          source: "table",
          "source-layer": SOURCE_LAYER,
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#08519c", "line-width": 1.2 }
        })
        map.addLayer({
          id: "table-point",
          type: "circle",
          source: "table",
          "source-layer": SOURCE_LAYER,
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": "#2171b5",
            "circle-opacity": 0.8,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1
          }
        })

        for (const layerId of ["table-fill", "table-line", "table-point"]) {
          map.on("click", layerId, event => {
            const feature = event.features?.[0]
            if (!feature) return
            const rows = Object.entries(feature.properties ?? {})
              .slice(0, 20)
              .map(
                ([key, value]) =>
                  `<tr><th>${escapeHtml(labelsRef.current?.[key] ?? key)}</th><td>${escapeHtml(String(value))}</td></tr>`
              )
              .join("")
            new Popup({ maxWidth: "320px" })
              .setLngLat(event.lngLat)
              .setHTML(`<table class="map-popup-table">${rows}</table>`)
              .addTo(map)
          })
          map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"))
          map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""))
        }

        if (extent) {
          const bounds = new LngLatBounds([extent[0], extent[1]], [extent[2], extent[3]])
          map.fitBounds(bounds, { padding: 40, animate: false })
        }
      })
    })
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
    }
    // Table identity owns the map; extent only frames the initial view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, mode])

  return <div ref={containerRef} className="layer-map" style={{ height: 520 }} />
}

/** Minimal HTML escaping for popup cell text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export default TableMap

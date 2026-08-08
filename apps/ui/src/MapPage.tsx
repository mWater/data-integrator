import { useEffect, useRef, useState } from "react"
import { LngLatBounds, Map as MapLibreMap, RasterTileSource } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { listLayers, MapLayer } from "./api.js"

/** Tile URL for a layer pinned to one snapshot. */
const tileUrl = (layerId: string, snapshotId: string) => `/tiles/${layerId}/${snapshotId}/{z}/{x}/{y}.png`

/** Props for the map page. */
interface MapPageProps {
  /** When set, this layer starts visible and the view fits to it */
  focusLayerId: string | null
}

/** Per-layer UI state. */
interface LayerControl {
  /** The catalog layer */
  layer: MapLayer
  /** Layer visibility */
  visible: boolean
  /** Index into layer.snapshots currently shown */
  index: number
}

/** Fits the view to a layer's footprint. */
function fitTo(map: MapLibreMap, layer: MapLayer) {
  if (!layer.footprint) return
  const bounds = new LngLatBounds()
  for (const point of layer.footprint.coordinates[0]) bounds.extend(point as [number, number])
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40 })
}

/**
 * Catalog layers on a MapLibre map. All layers start hidden (except a focused
 * one); the side panel is the picker, with a time slider for visible
 * time-series layers.
 */
export function MapPage({ focusLayerId }: MapPageProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [controls, setControls] = useState<LayerControl[]>([])

  useEffect(() => {
    const map = new MapLibreMap({
      container: container.current!,
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
    mapRef.current = map

    map.on("load", async () => {
      const { layers } = await listLayers()
      const withData = layers.filter(l => l.current_snapshot_id)
      const next: LayerControl[] = []
      for (const layer of withData) {
        const index = Math.max(0, layer.snapshots.findIndex(s => s.id === layer.current_snapshot_id))
        const visible = layer.id === focusLayerId
        map.addSource(layer.id, { type: "raster", tiles: [tileUrl(layer.id, layer.snapshots[index].id)], tileSize: 256 })
        map.addLayer({
          id: layer.id,
          type: "raster",
          source: layer.id,
          layout: { visibility: visible ? "visible" : "none" },
          paint: { "raster-opacity": 0.8 }
        })
        if (visible) fitTo(map, layer)
        next.push({ layer, visible, index })
      }
      setControls(next)
    })

    return () => map.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLayerId])

  /** Applies a control change to both React state and the map. */
  function update(id: string, change: Partial<LayerControl>) {
    setControls(current =>
      current.map(control => {
        if (control.layer.id !== id) return control
        const next = { ...control, ...change }
        const map = mapRef.current!
        map.setLayoutProperty(id, "visibility", next.visible ? "visible" : "none")
        if (next.index !== control.index) {
          const source = map.getSource(id) as RasterTileSource
          source.setTiles([tileUrl(id, next.layer.snapshots[next.index].id)])
        }
        return next
      })
    )
  }

  /** Shows a layer and zooms to its footprint. */
  function show(control: LayerControl) {
    update(control.layer.id, { visible: true })
    fitTo(mapRef.current!, control.layer)
  }

  return (
    <main className="map-page">
      <aside className="map-side">
        <h2>Layers</h2>
        {controls.length === 0 && <p className="dim">No layers with data yet</p>}
        {controls.map(control => {
          const { layer, visible, index } = control
          return (
            <div key={layer.id} className="layer">
              <div className="layer-row">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={e => update(layer.id, { visible: e.target.checked })}
                />
                <button type="button" className="layer-name" onClick={() => show(control)}>
                  {layer.name}
                </button>
              </div>
              {visible && (
                <div className="layer-detail">
                  <span className="when">
                    {layer.snapshots[index].observed_at.slice(0, layer.snapshots.length > 1 ? 7 : 10)}
                  </span>
                  {layer.snapshots.length > 1 && (
                    <input
                      type="range"
                      min={0}
                      max={layer.snapshots.length - 1}
                      value={index}
                      onChange={e => update(layer.id, { index: Number(e.target.value) })}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </aside>
      <div ref={container} className="map-container" />
    </main>
  )
}

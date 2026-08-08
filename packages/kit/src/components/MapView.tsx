/**
 * Map view over the raster catalog. Tile bytes come through the bridge
 * (the frame has no credentials), via a MapLibre custom protocol.
 */

import { useEffect, useRef } from "react"
import * as maplibregl from "maplibre-gl"
import { bridgeTile } from "../bridge.js"
import { useTheme } from "../hooks.js"

let protocolRegistered = false

function registerProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  // di-tile://<layerId>/<z>/<x>/<y>
  maplibregl.addProtocol("di-tile", async (params: maplibregl.RequestParameters) => {
    const [, layerId, z, x, y] = /^di-tile:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url) ?? []
    if (!layerId) throw new Error(`bad tile url: ${params.url}`)
    const data = await bridgeTile(layerId, Number(z), Number(x), Number(y))
    return { data }
  })
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
  /** Raster layers, drawn in order. */
  layers: MapLayer[]
  /** Initial center as [longitude, latitude]. */
  center: [number, number]
  /** Initial zoom level. */
  zoom: number
  /** Pixel height of the map. */
  height?: number
}

/** Interactive map rendering catalog raster layers via bridge-proxied tiles. */
export function MapView({ layers, center, zoom, height }: MapViewProps) {
  const theme = useTheme()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!el.current) return
    registerProtocol()
    const instance = new maplibregl.Map({
      container: el.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "background", type: "background", paint: { "background-color": theme.mode === "dark" ? "#101418" : "#e8ecef" } }]
      },
      center,
      zoom,
      attributionControl: false
    })
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }))
    instance.on("load", () => {
      for (const layer of layers) {
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
    })
    map.current = instance
    return () => {
      instance.remove()
      map.current = null
    }
    // Layers/center changes rebuild the map; dashboards re-mount rather than mutate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(layers), theme.mode])

  return <div ref={el} style={{ height: height ?? 380 }} />
}

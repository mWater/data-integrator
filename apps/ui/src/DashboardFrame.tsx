/**
 * Host-side dashboard frame: mounts a compiled bundle in the sandboxed iframe
 * and services its bridge with the viewer's session (queries, tiles, meta).
 */

import { useEffect, useRef } from "react"
// Themes come from /host so the eager bundle skips the component barrel
// (and its echarts side effects); kit components load with the blocks chunk
import { darkTheme, lightTheme, mountDashboardFrame } from "@data-integrator/kit/host"
import { KIT_VERSION } from "@data-integrator/kit/version"
import { execDashboardQuery, listLayers, listSources } from "./api.js"
import { useAppTheme } from "./theme.js"

/** Props for the dashboard frame host. */
interface Props {
  /** Dashboard id; stored-query calls route to it */
  dashboardId: string
  /** Compiled ESM bundle to mount */
  bundleJs: string
  /** Compiled stylesheet */
  bundleCss: string
  /** Kit version the bundle is pinned to */
  /** Draft override: executes queries via this handler instead of the saved dashboard */
  runQuery?: (name: string, params: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  /** Draft override: fetches vector tiles via this handler instead of the saved dashboard */
  fetchVectorTile?: (query: string, z: number, x: number, y: number, params: Record<string, unknown>) => Promise<ArrayBuffer>
  /** Called when the frame reports a runtime error */
  onError?: (message: string, stack?: string) => void
}

/** Fetches one MVT tile from a tile endpoint, params bound via the query string. */
export async function fetchTileBytes(
  base: string,
  query: string,
  z: number,
  x: number,
  y: number,
  params: Record<string, unknown>
): Promise<ArrayBuffer> {
  const search = Object.keys(params).length > 0 ? `?params=${encodeURIComponent(JSON.stringify(params))}` : ""
  const res = await fetch(`${base}/tiles/${query}/${z}/${x}/${y}.mvt${search}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `vector tile ${res.status}`)
  }
  return res.arrayBuffer()
}

/** Sandboxed dashboard iframe wired to the app's API. */
export function DashboardFrame({ dashboardId, bundleJs, bundleCss, runQuery, fetchVectorTile, onError }: Props) {
  const container = useRef<HTMLDivElement>(null)
  // Handlers live in refs, never in the effect deps: the bridge calls them
  // lazily, so a caller's inline lambda changing identity on every render
  // (e.g. typing in the session composer) must not remount the frame
  const errorRef = useRef(onError)
  errorRef.current = onError
  const runQueryRef = useRef(runQuery)
  runQueryRef.current = runQuery
  const fetchVectorTileRef = useRef(fetchVectorTile)
  fetchVectorTileRef.current = fetchVectorTile
  const { mode } = useAppTheme()

  useEffect(() => {
    if (!container.current) return
    let destroyed = false
    let frame: { destroy(): void } | null = null
    const snapshotByLayer = new Map<string, string>()

    const mount = async () => {
      // Freshness for useMeta() and layer -> current snapshot for tiles
      const [sources, layers] = await Promise.all([
        listSources().catch(() => ({ sources: [] })),
        listLayers().catch(() => ({ layers: [] }))
      ])
      for (const layer of layers.layers) {
        if (layer.current_snapshot_id) snapshotByLayer.set(layer.id, layer.current_snapshot_id)
      }
      const tables: Record<string, string | null> = {}
      for (const s of sources.sources) if (s.kind === "table") tables[s.id] = s.updatedAt
      // Snapshot timelines let dashboards drive a date control over a layer
      const layerInfo = layers.layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        temporality: layer.temporality,
        snapshots: (layer.snapshots ?? []).map(snapshot => ({
          id: snapshot.id,
          observedAt: snapshot.observed_at,
          observedEnd: snapshot.observed_end ?? null
        }))
      }))
      if (destroyed || !container.current) return

      frame = mountDashboardFrame({
        container: container.current,
        bundleJs,
        bundleCss,
        kitBase: `/kit/${KIT_VERSION}`,
        init: {
          locale: navigator.language || "en",
          theme: mode === "dark" ? darkTheme : lightTheme,
          meta: { tables },
          layers: layerInfo
        },
        handlers: {
          runQuery: (name, params) =>
            runQueryRef.current
              ? runQueryRef.current(name, params)
              : execDashboardQuery(dashboardId, name, params),
          fetchVectorTile: (query, z, x, y, params) =>
            fetchVectorTileRef.current
              ? fetchVectorTileRef.current(query, z, x, y, params)
              : fetchTileBytes(`/api/dashboards/${dashboardId}`, query, z, x, y, params),
          fetchTile: async (layerId, z, x, y, snapshotId) => {
            const snapshot = snapshotId ?? snapshotByLayer.get(layerId)
            if (!snapshot) throw new Error(`layer ${layerId} has no current snapshot`)
            const res = await fetch(`/tiles/${layerId}/${snapshot}/${z}/${x}/${y}.png`)
            if (!res.ok) throw new Error(`tile ${res.status}`)
            return res.arrayBuffer()
          },
          fetchBasemap: async path => {
            const res = await fetch(`/basemap/${path}`)
            if (!res.ok) throw new Error(`basemap ${res.status}`)
            return res.arrayBuffer()
          },
          onError: (message, stack) => errorRef.current?.(message, stack)
        }
      })
    }
    void mount()

    return () => {
      destroyed = true
      frame?.destroy()
    }
    // mode in deps: a theme change remounts the frame with the other token set
  }, [dashboardId, bundleJs, bundleCss, mode])

  return <div ref={container} className="dashboard-frame" />
}

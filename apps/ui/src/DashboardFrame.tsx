/**
 * Host-side dashboard frame: mounts a compiled bundle in the sandboxed iframe
 * and services its bridge with the viewer's session (queries, tiles, meta).
 */

import { useEffect, useRef } from "react"
// Themes come from /host so the eager bundle skips the component barrel
// (and its echarts side effects); kit components load with the blocks chunk
import { darkTheme, lightTheme, mountDashboardFrame } from "@data-integrator/kit/host"
import { KIT_VERSION } from "@data-integrator/kit/version"
import { DashboardMeta, execDashboardQuery, getDashboardMeta } from "./api.js"
import { useAppTheme } from "./theme.js"
import { localizeData } from "./localization.js"

/** Props for the dashboard frame host. */
interface Props {
  /** Dashboard id; stored-query calls route to it */
  dashboardId: string
  /** Compiled ESM bundle to mount */
  bundleJs: string
  /** Compiled stylesheet */
  bundleCss: string
  /** Kit version the bundle is pinned to */
  /** Receives a print function once the frame is mounted (null on unmount) */
  onPrintReady?: (print: (() => void) | null) => void
  /** Draft override: executes queries via this handler instead of the saved dashboard */
  runQuery?: (name: string, params: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  /** Draft override: fetches vector tiles via this handler instead of the saved dashboard */
  fetchVectorTile?: (query: string, z: number, x: number, y: number, params: Record<string, unknown>) => Promise<ArrayBuffer>
  /** Draft override: freshness/layer meta instead of the saved dashboard's declared set */
  fetchMeta?: () => Promise<DashboardMeta>
  /** Draft override: raster tile bytes instead of the saved dashboard's scoped route */
  fetchRasterTile?: (
    layerId: string,
    snapshotId: string,
    z: number,
    x: number,
    y: number,
    mask: boolean,
    maskKey: string | null
  ) => Promise<ArrayBuffer>
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
export function DashboardFrame({
  dashboardId,
  bundleJs,
  bundleCss,
  runQuery,
  fetchVectorTile,
  fetchMeta,
  fetchRasterTile,
  onError,
  onPrintReady
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const onPrintReadyRef = useRef(onPrintReady)
  onPrintReadyRef.current = onPrintReady
  // Handlers live in refs, never in the effect deps: the bridge calls them
  // lazily, so a caller's inline lambda changing identity on every render
  // (e.g. typing in the session composer) must not remount the frame
  const errorRef = useRef(onError)
  errorRef.current = onError
  const runQueryRef = useRef(runQuery)
  runQueryRef.current = runQuery
  const fetchVectorTileRef = useRef(fetchVectorTile)
  fetchVectorTileRef.current = fetchVectorTile
  const fetchRasterTileRef = useRef(fetchRasterTile)
  fetchRasterTileRef.current = fetchRasterTile
  const fetchMetaRef = useRef(fetchMeta)
  fetchMetaRef.current = fetchMeta
  const { mode } = useAppTheme()

  useEffect(() => {
    if (!container.current) return
    let destroyed = false
    let frame: { destroy(): void; print(): void } | null = null
    const snapshotByLayer = new Map<string, string>()
    // Tiles cache as immutable, so the mask shape's key rides in the URL
    const maskKeyByLayer = new Map<string, string>()

    const mount = async () => {
      // Freshness for useMeta() and declared layers with snapshot timelines;
      // the scoped endpoint serves public dashboards without a session
      const metaFetch = fetchMetaRef.current ?? (() => getDashboardMeta(dashboardId))
      const meta = await metaFetch().catch((): DashboardMeta => ({ tables: {}, layers: [] }))
      for (const layer of meta.layers) {
        if (layer.currentSnapshotId) snapshotByLayer.set(layer.id, layer.currentSnapshotId)
        if (layer.maskKey) maskKeyByLayer.set(layer.id, layer.maskKey)
      }
      const layerInfo = meta.layers.map(layer => ({
        id: layer.id,
        name: localizeData(layer.name),
        temporality: layer.temporality,
        snapshots: layer.snapshots
      }))
      if (destroyed || !container.current) return

      // Published before mount returns: the closure reads the frame when called
      onPrintReadyRef.current?.(() => frame?.print())
      frame = mountDashboardFrame({
        container: container.current,
        bundleJs,
        bundleCss,
        kitBase: `/kit/${KIT_VERSION}`,
        init: {
          locale: navigator.language || "en",
          theme: mode === "dark" ? darkTheme : lightTheme,
          meta: { tables: meta.tables },
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
          fetchTile: async (layerId, z, x, y, snapshotId, mask = true) => {
            const snapshot = snapshotId ?? snapshotByLayer.get(layerId)
            if (!snapshot) throw new Error(`layer ${layerId} has no current snapshot`)
            const key = maskKeyByLayer.get(layerId) ?? null
            if (fetchRasterTileRef.current) return fetchRasterTileRef.current(layerId, snapshot, z, x, y, mask, key)
            // Scoped to the dashboard: only its declared layers are served
            const query = mask ? (key ? `?m=${key}` : "") : "?mask=0"
            const res = await fetch(
              `/api/dashboards/${dashboardId}/rastertiles/${layerId}/${snapshot}/${z}/${x}/${y}.png${query}`
            )
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
      onPrintReadyRef.current?.(null)
      frame?.destroy()
    }
    // mode in deps: a theme change remounts the frame with the other token set
  }, [dashboardId, bundleJs, bundleCss, mode])

  return <div ref={container} className="dashboard-frame" />
}

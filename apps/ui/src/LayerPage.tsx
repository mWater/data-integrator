import { LoadState } from "./LoadState.js"
/**
 * One raster layer, the way TablePage is one table: what it is on the left,
 * the pixels on the right. Bands and snapshots are both switchable, since a
 * layer is a stack of measurements over time rather than a single image.
 */

import { Fragment, ReactNode, useEffect, useRef, useState } from "react"
import { LngLatBounds, Map as MapLibreMap, Popup, RasterTileSource, NavigationControl } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { basemapStyle } from "./maplibre.js"
import { getLayer, LayerBand, LayerDetail, sampleLayer, styleToken } from "./api.js"
import { useAppTheme } from "./theme.js"
import { formatDateTime, localizeData } from "./localization.js"

/**
 * Tile URL for one layer, snapshot and band. Tiles cache as immutable, so
 * everything that changes the pixels is in the URL: ?s for the style, m for
 * the mask shape, and mask=0 when drawing beyond the area.
 */
const tileUrl = (layer: LayerDetail, snapshotId: string, band: LayerBand, clip: boolean) =>
  `/tiles/${layer.id}/${snapshotId}/${band.id}/{z}/{x}/{y}.png?s=${styleToken(band.rendering)}` +
  (clip ? (layer.maskKey ? `&m=${layer.maskKey}` : "") : "&mask=0")

/** Id of the single maplibre layer this page draws into. */
const RASTER_LAYER = "raster"

/** Props for the layer page. */
interface LayerPageProps {
  /** Layer to show */
  layerId: string
  /** Design session whose scratch layers to read instead of the catalog */
  sessionId?: string | null
}

/** A band's display label. */
function bandLabel(band: LayerBand): string {
  return band.name ? localizeData(band.name) : band.id
}

/** Human byte size, for the storage line. */
/** One metadata value as text; http(s) URLs become links. */
function metadataValue(value: unknown): ReactNode {
  if (typeof value === "string") {
    return /^https?:\/\//.test(value) ? (
      <a href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    ) : (
      value
    )
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)
}

function bytes(n: number): string {
  if (n <= 0) return T`unknown`
  const units = [T`B`, T`KB`, T`MB`, T`GB`, T`TB`]
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const value = n / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** Snapshot timestamp, to the day for intervals and to the minute otherwise. */
function snapshotLabel(iso: string, interval: boolean): string {
  const date = new Date(iso)
  // Date-stamped snapshots are stored as midnight UTC; local clock time is noise
  const dateStamp =
    date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0
  if (interval || dateStamp) {
    return date.toLocaleDateString(undefined, dateStamp ? { timeZone: "UTC" } : undefined)
  }
  return formatDateTime(date)
}

/** Units worth printing; "1" and "dimensionless" are a scale, not a caption. */
function displayUnits(units?: string): string | null {
  if (!units) return null
  const key = units.trim().toLowerCase()
  if (key === "1" || key === "dimensionless") return null
  return units
}

/** Pixel value in a click popup; enough digits for fractions, no trailing zeros. */
function formatSample(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/** Minimal HTML escaping for popup text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** Color ramp legend from the band's declared color map. */
function Legend({ band }: { band: LayerBand }) {
  const stops = band.rendering?.colorMap
  if (!stops || stops.length < 2) return null
  const min = stops[0].value
  const max = stops[stops.length - 1].value
  const span = max - min || 1
  const gradient = stops.map(s => `${s.color} ${((s.value - min) / span) * 100}%`).join(", ")
  const units = displayUnits(band.units)
  return (
    <section className="layer-section">
      <h2>{T`Legend`}</h2>
      <div className="layer-legend">
        <div className="layer-ramp" style={{ background: `linear-gradient(to right, ${gradient})` }} />
        <div className="layer-ramp-ends">
          <span>{min.toLocaleString()}</span>
          <span>{max.toLocaleString()}</span>
        </div>
        {units ? <div className="dim">{units}</div> : null}
      </div>
    </section>
  )
}

/** The raster layer page: detail panel plus its own map. */
export function LayerPage({ layerId, sessionId }: LayerPageProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const mapModeRef = useRef<"light" | "dark" | null>(null)
  const { mode } = useAppTheme()
  const [layer, setLayer] = useState<LayerDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [bandId, setBandId] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [controlsOpen, setControlsOpen] = useState(false)
  const controlsToggle = useRef<HTMLButtonElement>(null)
  const [opacity, setOpacity] = useState(0.65)
  const opacityRef = useRef(opacity)
  // Clip the drawing to the layer's area of interest; off shows the
  // surroundings the integration fetched beyond it
  const [clip, setClip] = useState(true)
  const clipRef = useRef(clip)
  const inspectRef = useRef({
    layerId,
    snapshotId: "",
    bandId: "" as string | null,
    sessionId: sessionId ?? null,
    bandName: "",
    units: null as string | null
  })

  useEffect(() => {
    let cancelled = false
    setError(null)
    setLayer(null)
    mapRef.current?.remove()
    mapRef.current = null
    getLayer(layerId, sessionId).then(detail => {
      if (cancelled) return
      setLayer(detail)
      setBandId(detail.bands[0]?.id ?? null)
      const current = detail.snapshots.findIndex(s => s.id === detail.currentSnapshotId)
      setIndex(current >= 0 ? current : Math.max(0, detail.snapshots.length - 1))
    }, err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [layerId, sessionId, retry])

  // The map is created once the layer is known, so the first tiles are right.
  // A theme flip rebuilds it on the other basemap style.
  useEffect(() => {
    if (!layer || !bandId || layer.snapshots.length === 0) return
    if (mapRef.current && mapModeRef.current === mode) return
    mapRef.current?.remove()
    mapRef.current = null
    let cancelled = false
    void basemapStyle(mode).then(style => {
      if (cancelled || !container.current) return
      mapModeRef.current = mode
      const map = new MapLibreMap({
        container: container.current,
        style,
        center: [30, -10],
        zoom: 3
      })
      map.addControl(new NavigationControl({ showCompass: false }))
      mapRef.current = map
      map.on("load", () => {
        map.addSource(RASTER_LAYER, {
          type: "raster",
          tiles: [tileUrl(layer, layer.snapshots[index].id, layer.bands.find(b => b.id === bandId) ?? layer.bands[0], clipRef.current)],
          tileSize: 256
        })
        map.addLayer({ id: RASTER_LAYER, type: "raster", source: RASTER_LAYER, paint: { "raster-opacity": opacityRef.current } })
        if (layer.footprint) {
          const bounds = new LngLatBounds()
          for (const point of layer.footprint.coordinates[0]) bounds.extend(point as [number, number])
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, animate: false })
        }
        map.getCanvas().style.cursor = "crosshair"
        const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: "220px" })
        let seq = 0
        map.on("click", async e => {
          const id = ++seq
          const inspect = inspectRef.current
          if (!inspect.snapshotId) return
          popup
            .setLngLat(e.lngLat)
            .setHTML(`<div class="map-sample"><div class="map-sample-value dim">…</div></div>`)
            .addTo(map)
          try {
            const sample = await sampleLayer(
              inspect.layerId,
              inspect.snapshotId,
              e.lngLat.lng,
              e.lngLat.lat,
              inspect.bandId,
              inspect.sessionId
            )
            if (id !== seq) return
            const valueHtml =
              sample.value == null
                ? `<div class="map-sample-value dim">${escapeHtml(T`No data`)}</div>`
                : `<div class="map-sample-value">${escapeHtml(formatSample(sample.value))}${
                    inspect.units ? ` <span class="dim">${escapeHtml(inspect.units)}</span>` : ""
                  }</div>`
            popup.setHTML(
              `<div class="map-sample"><div class="map-sample-name">${escapeHtml(inspect.bandName)}</div>${valueHtml}</div>`
            )
          } catch {
            if (id !== seq) return
            popup.setHTML(
              `<div class="map-sample"><div class="map-sample-value dim">${escapeHtml(T`No data`)}</div></div>`
            )
          }
        })
      })
    })
    return () => {
      cancelled = true
    }
    // Layer identity drives creation; band and snapshot changes retile below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, bandId, mode])

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(() => mapRef.current?.resize())
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [layer])

  // Band and time changes only swap the source's tile template. Retiling is
  // debounced: a slider drag emits every intermediate snapshot, and reloading
  // tiles for each one queues hundreds of requests the browser must drain
  // before the final position renders.
  useEffect(() => {
    const timer = setTimeout(() => {
      const map = mapRef.current
      if (!map || !layer || !bandId || !map.getSource(RASTER_LAYER)) return
      const source = map.getSource(RASTER_LAYER) as RasterTileSource
      clipRef.current = clip
      source.setTiles([tileUrl(layer, layer.snapshots[index].id, layer.bands.find(b => b.id === bandId) ?? layer.bands[0], clip)])
    }, 200)
    return () => clearTimeout(timer)
  }, [layer, bandId, index, clip])

  useEffect(() => {
    opacityRef.current = opacity
    const map = mapRef.current
    if (map?.getLayer(RASTER_LAYER)) map.setPaintProperty(RASTER_LAYER, "raster-opacity", opacity)
  }, [opacity])

  useEffect(() => () => {
    mapRef.current?.remove()
    mapRef.current = null
  }, [])

  if (error) {
    return (
      <main className="list-page">
        <a className="page-back" href="#/data">← {T`Data`}</a><LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
      </main>
    )
  }
  if (!layer) return <main className="list-page"><a className="page-back" href="#/data">← {T`Data`}</a><LoadState onRetry={() => setRetry(n => n + 1)} /></main>

  const band = layer.bands.find(b => b.id === bandId) ?? layer.bands[0]
  const snapshot = layer.snapshots[index]
  const interval = snapshot?.observed_end != null
  inspectRef.current = {
    layerId,
    snapshotId: snapshot?.id ?? "",
    bandId,
    sessionId: sessionId ?? null,
    bandName: band ? bandLabel(band) : "",
    units: band ? displayUnits(band.units) : null
  }

  return (
    <main className={`layer-page${controlsOpen ? " layer-controls-open" : ""}`}>
      <div className="layer-mobile-toolbar">
        <div><strong>{localizeData(layer.name)}</strong>{snapshot && <span>{snapshotLabel(snapshot.observed_at, interval)}</span>}</div>
        <button ref={controlsToggle} className="secondary" aria-expanded={controlsOpen} aria-controls="layer-controls" onClick={() => setControlsOpen(!controlsOpen)}>
          {controlsOpen ? T`Hide Controls` : T`Map Controls`}
        </button>
      </div>
      <aside id="layer-controls" className="layer-side" aria-label={T`Map controls`} onKeyDown={e => {
        if (e.key === "Escape" && controlsOpen) { setControlsOpen(false); controlsToggle.current?.focus() }
      }}>
        <div className="layer-head">
          <a className="page-back" href="#/data">← {T`Data`}</a>
          <h1>{localizeData(layer.name)}</h1>
          <div className="dim">{layer.id}</div>
          <a className="dim-link" href={`#/integration/${layer.integrationId}`}>
            {T`from ${localizeData(layer.integrationName)}`}
          </a>
        </div>

        {layer.snapshots.length === 0 ? (
          <p className="dim">
            {T`No data yet. Snapshots appear here once ${(
              <a key="integration" href={`#/integration/${layer.integrationId}`}>
                {localizeData(layer.integrationName)}
              </a>
            )} runs.`}
          </p>
        ) : (
          <>
            {layer.bands.length > 1 && (
              <section className="layer-section">
                <h2>{T`Band`}</h2>
                <div className="layer-bands">
                  {layer.bands.map(b => (
                    <button
                      key={b.id}
                      className={`layer-band${b.id === band?.id ? " active" : ""}`}
                      aria-pressed={b.id === band?.id}
                      onClick={() => setBandId(b.id)}
                    >
                      <span className="layer-band-name">{bandLabel(b)}</span>
                      {displayUnits(b.units) && <span className="dim">{displayUnits(b.units)}</span>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="layer-section">
              <h2>{layer.snapshots.length > 1 ? T`Time` : T`Observed`}</h2>
              <div className="layer-when">{snapshotLabel(snapshot.observed_at, interval)}</div>
              {interval && snapshot.observed_end && (
                <div className="dim">{T`through ${snapshotLabel(snapshot.observed_end, true)}`}</div>
              )}
              {snapshot.sources === 0 && <div className="dim">{T`Nothing observed: this snapshot is empty.`}</div>}
              {layer.snapshots.length > 1 && (
                <>
                  <input
                    type="range"
                    min={0}
                    max={layer.snapshots.length - 1}
                    value={index}
                    aria-label={T`Snapshot time`}
                    onChange={e => setIndex(Number(e.target.value))}
                  />
                  <div className="dim">
                    {T`${index + 1} of ${layer.snapshots.length} snapshots`}
                  </div>
                </>
              )}
            </section>

            {band && <Legend band={band} />}

            <section className="layer-section">
              <h2>{T`Opacity`}</h2>
              <input
                type="range"
                min={10}
                max={100}
                value={Math.round(opacity * 100)}
                aria-label={T`Layer opacity`}
                onChange={e => setOpacity(Number(e.target.value) / 100)}
              />
              <div className="dim">{Math.round(opacity * 100)}%</div>
              {layer.masked && (
                <label className="layer-clip">
                  <input type="checkbox" checked={clip} onChange={e => setClip(e.target.checked)} />{" "}
                  {T`Clip to area of interest`}
                </label>
              )}
            </section>
          </>
        )}

        {(layer.description || layer.source) && (
          <section className="layer-section">
            <h2>{T`Source`}</h2>
            {layer.description && <p className="layer-description">{localizeData(layer.description)}</p>}
            {layer.source && (
              <dl className="layer-facts">
                <dt>{T`Dataset`}</dt>
                <dd>
                  {layer.source.url ? (
                    <a href={layer.source.url} target="_blank" rel="noreferrer">
                      {localizeData(layer.source.name)}
                    </a>
                  ) : (
                    localizeData(layer.source.name)
                  )}
                </dd>
                {layer.source.provider && (
                  <>
                    <dt>{T`Provider`}</dt>
                    <dd>{layer.source.provider}</dd>
                  </>
                )}
                {layer.source.license && (
                  <>
                    <dt>{T`License`}</dt>
                    <dd>{layer.source.license}</dd>
                  </>
                )}
                {layer.source.documentation && (
                  <>
                    <dt>{T`Docs`}</dt>
                    <dd>
                      <a href={layer.source.documentation} target="_blank" rel="noreferrer">
                        {T`Documentation`}
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            )}
            {layer.source?.limitations && (
              <p className="layer-limitations">{localizeData(layer.source.limitations)}</p>
            )}
          </section>
        )}

        <section className="layer-section">
          <h2>{T`Details`}</h2>
          <dl className="layer-facts">
            <dt>{T`From`}</dt>
            <dd>
              <a href={`#/integration/${layer.integrationId}`}>{localizeData(layer.integrationName)}</a>
            </dd>
            <dt>{T`Kind`}</dt>
            <dd>{layer.temporality === "time-series" ? T`Time series` : T`Current only`}</dd>
            {layer.retentionDays != null && (
              <>
                <dt>{T`History`}</dt>
                <dd>{T`Last ${layer.retentionDays} days`}</dd>
              </>
            )}
            <dt>{T`Bands`}</dt>
            <dd>{layer.bands.map(bandLabel).join(", ") || T`none declared`}</dd>
            {/* A declared NaN cannot survive jsonb, so it arrives as null;
                only a real sentinel value is worth a row */}
            {typeof band?.nodata === "number" && Number.isFinite(band.nodata) && (
              <>
                <dt>{T`No data`}</dt>
                <dd>{band.nodata.toLocaleString()}</dd>
              </>
            )}
            <dt>{T`Snapshots`}</dt>
            <dd>{layer.snapshots.length.toLocaleString()}</dd>
            {layer.crs && (
              <>
                <dt>{T`CRS`}</dt>
                <dd>{layer.crs}</dd>
              </>
            )}
            <dt>{T`Storage`}</dt>
            <dd>{bytes(layer.sizeBytes)}</dd>
          </dl>
          {layer.metadata && Object.keys(layer.metadata).length > 0 && (
            <details className="layer-metadata">
              <summary>{T`Source details of the current snapshot`}</summary>
              <dl className="layer-facts">
                {Object.entries(layer.metadata).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{metadataValue(value)}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
          )}
        </section>
      </aside>
      {layer.snapshots.length === 0 ? (
        <div className="layer-map layer-map-empty">
          <p>{T`Nothing to draw yet. This layer has no promoted snapshots.`}</p>
        </div>
      ) : (
        <div ref={container} className="layer-map" />
      )}
    </main>
  )
}

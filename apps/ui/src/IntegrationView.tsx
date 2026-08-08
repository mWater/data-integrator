import { useCallback, useEffect, useRef, useState } from "react"
import { createSession, getIntegration, getTableRows, IntegrationDetail, startRun } from "./api.js"
import { triggerLabel } from "./IntegrationList.js"

/** Props for the integration detail view. */
interface IntegrationViewProps {
  /** Integration to display */
  integrationId: string
  /** False for viewers: hides Design with Agent and Run Now */
  canDesign: boolean
}

/** Detail tabs. */
type Tab = "runs" | "data" | "definition" | "code"

/** Poll cadence while a run is in flight. */
const POLL_MS = 2500

/** One installed integration: data, run history, definition, code. */
export function IntegrationView({ integrationId, canDesign }: IntegrationViewProps) {
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [picked, setPicked] = useState<Tab | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    getIntegration(integrationId).then(setDetail, err => setError(err.message))
  }, [integrationId])

  useEffect(() => {
    refresh()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [refresh])

  const running = detail?.runs.some(run => run.status === "queued" || run.status === "running") ?? false

  // Poll while a run is in flight so the table refreshes itself
  useEffect(() => {
    if (running && !pollTimer.current) {
      pollTimer.current = setInterval(refresh, POLL_MS)
    } else if (!running && pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [running, refresh])

  async function onRun() {
    setError(null)
    try {
      await startRun(integrationId)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onDesign() {
    setError(null)
    try {
      const { sessionId } = await createSession(integrationId)
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!detail) return <main className="list-page">{error ? <div className="error">{error}</div> : "Loading…"}</main>

  const { definition } = detail
  const tableIds = detail.destinations.filter(d => d.kind === "table").map(d => d.id)
  // Data leads when there is data to show; raster-only integrations lead with runs
  const tab = picked ?? (tableIds.length > 0 ? "data" : "runs")
  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{definition.name}</h1>
        {detail.status === "draft" && <span className="chip chip-draft">draft</span>}
        <span className="chip">{triggerLabel(definition.trigger as { cron?: string })}</span>
        <span style={{ flex: 1 }} />
        {canDesign && (
          <button onClick={onRun} disabled={running}>
            {running ? "Running…" : "Run Now"}
          </button>
        )}
        {canDesign && <button onClick={onDesign}>Design with Agent</button>}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="dest-cards">
        {detail.destinations.map(d => (
          <div key={d.id} className="dest-card">
            <div className="dim">{d.kind === "table" ? "table" : "raster layer"}</div>
            <b>{d.id}</b>
            <div>
              {d.count === null
                ? "no data yet"
                : `${d.count.toLocaleString()} ${d.kind === "table" ? "rows" : "snapshots"}`}
            </div>
            {d.kind === "raster" && d.count !== null && <a href={`#/map/${d.id}`}>View on map</a>}
          </div>
        ))}
      </div>

      <div className="tabs">
        {([...(tableIds.length ? ["data" as const] : []), "runs", "definition", "code"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setPicked(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "runs" &&
        (detail.runs.length === 0 ? (
          <p>No runs yet.</p>
        ) : (
          <table className="sessions">
            <thead>
              <tr><th>When</th><th>Trigger</th><th>Status</th><th>Result</th></tr>
            </thead>
            <tbody>
              {detail.runs.map(run => (
                <tr key={run.id}>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "queued"}</td>
                  <td>{run.trigger}</td>
                  <td><span className={`chip chip-${run.status}`}>{run.status}</span></td>
                  <td className="dim">
                    {run.error
                      ? run.error.slice(0, 120)
                      : run.stats
                        ? `${Object.entries(run.stats.rows ?? {}).map(([t, n]) => `${t}: ${n}`).join(", ") || `${run.stats.snapshots ?? 0} snapshots`} in ${((run.stats.durationMs ?? 0) / 1000).toFixed(1)}s`
                        : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === "data" && <DataTab integrationId={integrationId} tableIds={tableIds} />}
      {tab === "definition" && <DefinitionTab definition={definition} />}
      {tab === "code" && <pre className="pane pane-block pane-code">{definition.code}</pre>}
    </main>
  )
}

/** Column of a table destination as the definition declares it. */
interface ColumnSpec {
  /** Column id (SQL name) */
  id: string
  /** Display name */
  name?: string
  /** Column type */
  type: string
  /** Units of measure */
  units?: string
  /** Values when type is enum */
  enumValues?: { id: string; name?: string }[]
}

/** Table destination fields the definition tab renders. */
interface TableDest {
  /** Destination kind */
  kind: "table"
  /** Table id */
  tableId: string
  /** Load action */
  action: string
  /** Merge key columns */
  mergeColumns?: string[]
  /** Declared columns */
  columns: ColumnSpec[]
}

/** Raster destination fields the definition tab renders. */
interface RasterDest {
  /** Destination kind */
  kind: "raster"
  /** Layer id */
  layerId: string
  /** Display name */
  name?: string
  /** time-series or current-only */
  temporality: string
  /** Declared bands */
  bands: { id: string; name?: string; units?: string }[]
}

/** Props for the definition tab. */
interface DefinitionTabProps {
  /** Installed definition (loosely typed JSON) */
  definition: Record<string, unknown>
}

/** Human-readable definition: description, source, schedule, and per-destination schemas. */
function DefinitionTab({ definition }: DefinitionTabProps) {
  const source = definition.source as { name?: string; url?: string; license?: string } | undefined
  const destinations = (definition.destinations ?? []) as (TableDest | RasterDest)[]
  return (
    <div className="definition-tab">
      {typeof definition.description === "string" && <p>{definition.description}</p>}
      <dl className="facts">
        {source?.name && (
          <>
            <dt>Source</dt>
            <dd>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a>
              ) : (
                source.name
              )}
              {source.license ? ` · ${source.license}` : ""}
            </dd>
          </>
        )}
        <dt>Schedule</dt>
        <dd>{triggerLabel((definition.trigger ?? {}) as { cron?: string })}</dd>
      </dl>
      {destinations.map(dest =>
        dest.kind === "table" ? (
          <div key={dest.tableId} className="dest-def">
            <h3>
              {dest.tableId}{" "}
              <span className="dim">
                table · {dest.action}
                {dest.mergeColumns ? ` on ${dest.mergeColumns.join(", ")}` : ""}
              </span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>Column</th><th>Type</th><th>Units</th></tr>
              </thead>
              <tbody>
                {dest.columns.map(column => (
                  <tr key={column.id}>
                    <td>
                      <b>{column.name ?? column.id}</b>
                      {column.name && column.name !== column.id && <div className="dim">{column.id}</div>}
                    </td>
                    <td>
                      {column.type}
                      {column.type === "enum" && column.enumValues
                        ? `: ${column.enumValues.map(v => v.name ?? v.id).join(", ")}`
                        : ""}
                    </td>
                    <td>{column.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div key={dest.layerId} className="dest-def">
            <h3>
              {dest.name ?? dest.layerId} <span className="dim">raster · {dest.temporality}</span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>Band</th><th>Units</th></tr>
              </thead>
              <tbody>
                {dest.bands.map(band => (
                  <tr key={band.id}>
                    <td>{band.name ?? band.id}</td>
                    <td>{band.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

/** Props for the data preview tab. */
interface DataTabProps {
  /** Integration whose tables are shown */
  integrationId: string
  /** Destination table ids */
  tableIds: string[]
}

/** Newest-rows preview of one destination table at a time. */
function DataTab({ integrationId, tableIds }: DataTabProps) {
  const [tableId, setTableId] = useState(tableIds[0])
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPreview(null)
    setError(null)
    getTableRows(integrationId, tableId).then(setPreview, err => setError(err.message))
  }, [integrationId, tableId])

  return (
    <div>
      {tableIds.length > 1 && (
        <select value={tableId} onChange={e => setTableId(e.target.value)}>
          {tableIds.map(id => (
            <option key={id}>{id}</option>
          ))}
        </select>
      )}
      {error && <div className="error">{error}</div>}
      {!preview && !error && <p>Loading…</p>}
      {preview && (
        <div className="data-scroll">
          <table className="sessions data-table">
            <thead>
              <tr>{preview.columns.map(c => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i}>
                  {preview.columns.map(c => (
                    <td key={c}>{cellText(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim">Newest {preview.rows.length} rows</p>
        </div>
      )}
    </div>
  )
}

/** Renders one cell: dates and objects (geometry) get compact text forms. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    const geo = value as { type?: string; coordinates?: unknown }
    if (geo.type && geo.coordinates) return `${geo.type}(${JSON.stringify(geo.coordinates).slice(0, 40)}…)`
    return JSON.stringify(value).slice(0, 80)
  }
  return String(value)
}

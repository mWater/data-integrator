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

/** One installed integration: destinations, run history, data, definition, code. */
export function IntegrationView({ integrationId, canDesign }: IntegrationViewProps) {
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [tab, setTab] = useState<Tab>("runs")
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
  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{definition.name}</h1>
        <span className="chip">{definition.runtime}</span>
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
        {(["runs", ...(tableIds.length ? ["data" as const] : []), "definition", "code"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
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
      {tab === "definition" && (
        <pre className="pane pane-block">{JSON.stringify({ ...definition, code: undefined }, null, 2)}</pre>
      )}
      {tab === "code" && <pre className="pane pane-block pane-code">{definition.code}</pre>}
    </main>
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

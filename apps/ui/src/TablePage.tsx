import { useEffect, useState } from "react"
import { DataSource, getTableRows, listSources } from "./api.js"

/** Props for the table page. */
interface TablePageProps {
  /** Destination table to display */
  tableId: string
}

/** One destination table: the data itself, with a quiet link to the owning integration. */
export function TablePage({ tableId }: TablePageProps) {
  const [source, setSource] = useState<DataSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSource(null)
    setError(null)
    // The catalog resolves the owning integration, which the rows API needs
    listSources().then(r => {
      const found = r.sources.find(s => s.kind === "table" && s.id === tableId)
      if (found) setSource(found)
      else setError(`No table "${tableId}"`)
    }, err => setError(err.message))
  }, [tableId])

  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{source?.name ?? tableId}</h1>
        {source && <span className="chip chip-table">table</span>}
        <span style={{ flex: 1 }} />
        {source && <a href={`#/integration/${source.integrationId}`}>From integration “{source.integrationName}”</a>}
      </div>
      {source && (
        <p className="dim">
          {source.id}
          {source.rows !== null ? ` · ${source.rows.toLocaleString()} rows` : ""}
          {source.updatedAt ? ` · updated ${new Date(source.updatedAt).toLocaleString()}` : ""}
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {!source && !error && <p>Loading…</p>}
      {source && <DataTab integrationId={source.integrationId} tableIds={[tableId]} running={false} />}
    </main>
  )
}

/** Props for the table data preview. */
interface DataTabProps {
  /** Integration whose tables are shown */
  integrationId: string
  /** Destination table ids */
  tableIds: string[]
  /** True while a run is in flight; the preview refetches when it settles */
  running: boolean
}

/** Newest-rows preview of one destination table at a time. */
export function DataTab({ integrationId, tableIds, running }: DataTabProps) {
  const [tableId, setTableId] = useState(tableIds[0])
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPreview(null)
    setError(null)
    getTableRows(integrationId, tableId).then(setPreview, err => setError(err.message))
  }, [integrationId, tableId, running])

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
      {preview && preview.rows.length === 0 && <p>No rows yet.</p>}
      {preview && preview.rows.length > 0 && (
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

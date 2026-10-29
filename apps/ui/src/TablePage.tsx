import { LoadState } from "./LoadState.js"
import { lazy, Suspense, useEffect, useState } from "react"
import { DataSource, getTableGeometry, getTableRows, listSources, listTableSchemas, TableColumn } from "./api.js"
import { formatDateTime, localizeData } from "./localization.js"

// The map owns the maplibre chunk; keep it out of the first paint
const TableMap = lazy(() => import("./TableMap.js").then(m => ({ default: m.TableMap })))

/** Props for the table page. */
interface TablePageProps {
  /** Destination table to display */
  tableId: string
}

/** One destination table: the data itself, with a quiet link to the owning integration. */
export function TablePage({ tableId }: TablePageProps) {
  const [source, setSource] = useState<DataSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [geometry, setGeometry] = useState<{
    geometryColumn: string | null
    extent: [number, number, number, number] | null
  } | null>(null)
  const [columns, setColumns] = useState<TableColumn[] | null>(null)
  const [view, setView] = useState<"data" | "map">("data")

  useEffect(() => {
    setSource(null)
    setError(null)
    setGeometry(null)
    setColumns(null)
    setView("data")
    getTableGeometry(tableId).then(setGeometry, () => setGeometry(null))
    // Declared column specs carry the localized display names
    listTableSchemas().then(
      r => setColumns(r.tables.find(t => t.tableId === tableId)?.columns ?? null),
      () => setColumns(null)
    )
    // The catalog resolves the owning integration, which the rows API needs
    listSources().then(r => {
      const found = r.sources.find(s => s.kind === "table" && s.id === tableId)
      if (found) setSource(found)
      else setError(T`No table "${tableId}"`)
    }, err => setError(err.message))
  }, [tableId, retry])

  return (
    <main className="list-page wide">
      <a className="page-back" href="#/data">← {T`Data`}</a>
      <div className="session-head">
        <h1>{source ? localizeData(source.name) : tableId}</h1>
        {source && <span className="chip chip-table">{T`table`}</span>}
        <span style={{ flex: 1 }} />
        {source && (
          <a href={`#/integration/${source.integrationId}`}>{T`From integration “${localizeData(source.integrationName)}”`}</a>
        )}
      </div>
      {source && (
        <p className="dim">
          {source.id}
          {source.rows !== null ? ` · ${T`${source.rows.toLocaleString()} rows`}` : ""}
          {source.updatedAt ? ` · ${T`updated ${formatDateTime(source.updatedAt)}`}` : ""}
        </p>
      )}
      {!source && <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />}
      {source && geometry?.geometryColumn && (
        <div className="view-toggle">
          <button className={view === "data" ? "" : "secondary"} onClick={() => setView("data")}>
            {T`Data`}
          </button>
          <button className={view === "map" ? "" : "secondary"} onClick={() => setView("map")}>
            {T`Map`}
          </button>
        </div>
      )}
      {source && view === "map" && geometry?.geometryColumn ? (
        <Suspense fallback={<p>{T`Loading map…`}</p>}>
          <TableMap
            tableId={tableId}
            extent={geometry.extent}
            columnLabels={Object.fromEntries(
              (columns ?? []).filter(c => c.name).map(c => [c.id, localizeData(c.name)])
            )}
          />
        </Suspense>
      ) : (
        source && (
          <DataTab
            integrationId={source.integrationId}
            tableIds={[tableId]}
            running={false}
            columnSpecs={columns ? { [tableId]: columns } : undefined}
          />
        )
      )}
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
  /** Declared column specs per table id, for localized header names */
  columnSpecs?: Record<string, TableColumn[]>
}

/** Newest-rows preview of one destination table at a time. */
export function DataTab({ integrationId, tableIds, running, columnSpecs }: DataTabProps) {
  const [tableId, setTableId] = useState(tableIds[0])
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    setPreview(null)
    setError(null)
    getTableRows(integrationId, tableId).then(setPreview, err => setError(err.message))
  }, [integrationId, tableId, running, retry])

  return (
    <div>
      {tableIds.length > 1 && (
        <select value={tableId} onChange={e => setTableId(e.target.value)} aria-label={T`Table`}>
          {tableIds.map(id => (
            <option key={id}>{id}</option>
          ))}
        </select>
      )}
      {!preview && <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />}
      {preview && preview.rows.length === 0 && <p>{T`No rows yet.`}</p>}
      {preview && preview.rows.length > 0 && (
        <div className="data-scroll">
          <table className="sessions data-table">
            <thead>
              <tr>
                {preview.columns.map(c => {
                  const spec = columnSpecs?.[tableId]?.find(s => s.id === c)
                  const label = spec?.name ? localizeData(spec.name) : c
                  return (
                    <th key={c}>
                      {label}
                      {label !== c && <div className="dim">{c}</div>}
                    </th>
                  )
                })}
              </tr>
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
          <p className="dim">{T`Newest ${preview.rows.length} rows`}</p>
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

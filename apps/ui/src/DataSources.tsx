import { LoadState } from "./LoadState.js"
import { useEffect, useMemo, useState } from "react"
import { DataSource, listSources } from "./api.js"
import { formatDateTime, localizeData } from "./localization.js"

/** A source kind's display label, translated at call time. */
function kindLabel(kind: DataSource["kind"]): string {
  return kind === "table" ? T`table` : T`raster`
}

/** True when the source should appear for this search string (already lowercased). */
function matches(source: DataSource, q: string): boolean {
  if (!q) return true
  const hay = [
    localizeData(source.name),
    source.id,
    localizeData(source.description),
    localizeData(source.integrationName),
    kindLabel(source.kind)
  ]
  return hay.some(s => s.toLowerCase().includes(q))
}

/** Landing page: the data catalog — every table and raster layer on the server. */
export function DataSources() {
  const [sources, setSources] = useState<DataSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "table" | "raster">("all")

  useEffect(() => {
    setError(null)
    listSources().then(r => setSources(r.sources), err => setError(err.message))
  }, [retry])

  const shown = useMemo(() => {
    if (!sources) return []
    const q = query.trim().toLowerCase()
    return sources
      .filter(source => (filter === "all" || source.kind === filter) && matches(source, q))
      .sort(
        (a, b) =>
          localizeData(a.name).localeCompare(localizeData(b.name), undefined, { sensitivity: "base" }) ||
          a.id.localeCompare(b.id)
      )
  }, [sources, query, filter])

  return (
    <main className="list-page catalog-page">
      <header className="catalog-header"><h1>{T`Data`}</h1><p>{T`Explore the tables and map layers in your deployment.`}</p></header>
      {error && sources !== null && <div className="error" role="alert">{error}</div>}
      {sources === null ? (
        <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
      ) : sources.length === 0 ? (
        <p>
          {T`No data yet. Data sources appear here once an ${<a href="#/integrations">{T`integration`}</a>} runs.`}
        </p>
      ) : (
        <>
          <div className="catalog-toolbar">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={T`Search sources`}
              aria-label={T`Search sources`}
            />
            <div className="catalog-filters" role="group" aria-label={T`Filter data sources`}>
              {([["all", T`All`], ["table", T`Tables`], ["raster", T`Raster Layers`]] as const).map(([value, label]) => (
                <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{sources.filter(s => value === "all" || s.kind === value).length}</span></button>
              ))}
            </div>
          </div>
          <p className="catalog-count" role="status">{shown.length === 1 ? T`1 source` : T`${shown.length} sources`}</p>
          {shown.length === 0 ? (
            <div className="catalog-empty"><h2>{T`No sources found`}</h2><p>{T`Try another search or view all sources.`}</p><button className="secondary" onClick={() => { setQuery(""); setFilter("all") }}>{T`Clear Filters`}</button></div>
          ) : (
            <div className="catalog-list">
              {shown.map(source => {
                const href = source.kind === "raster" ? `#/layer/${source.id}` : `#/table/${source.id}`
                return <article className="catalog-entry" key={`${source.kind}:${source.id}`}>
                  <div className="catalog-copy">
                    <div className="catalog-name"><a href={href}>{localizeData(source.name)}</a><span className={`chip chip-${source.kind}`}>{kindLabel(source.kind)}</span></div>
                    {source.description && <p className="catalog-description">{localizeData(source.description)}</p>}
                    <a className="catalog-origin" href={`#/integration/${source.integrationId}`}>{T`from ${localizeData(source.integrationName)}`}</a>
                  </div>
                  <div className="catalog-meta">
                    <span>{source.kind === "table"
                      ? source.rows === null ? T`No data yet` : T`${source.rows.toLocaleString()} rows · ${source.columns} columns`
                      : source.snapshots === 1 ? T`1 snapshot` : T`${source.snapshots ?? 0} snapshots`}</span>
                    <span className="catalog-date-label">{source.kind === "raster" ? T`Latest observation` : T`Last ingested`}</span>
                    {source.updatedAt ? <time dateTime={source.updatedAt} title={formatDateTime(source.updatedAt)}>{source.kind === "raster"
                      ? new Date(source.updatedAt).toLocaleDateString(undefined, {timeZone: "UTC", year: "numeric", month: "short", day: "numeric"})
                      : formatDateTime(source.updatedAt)}</time> : <span className="dim">{T`Not available`}</span>}
                  </div>
                  <a className="catalog-open" href={href}>{source.kind === "raster" ? T`View Map` : T`Open Table`} <span aria-hidden="true">→</span></a>
                </article>
              })}
            </div>
          )}
        </>
      )}
    </main>
  )
}

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
  const [query, setQuery] = useState("")

  useEffect(() => {
    listSources().then(r => setSources(r.sources), err => setError(err.message))
  }, [])

  const shown = useMemo(() => {
    if (!sources) return []
    const q = query.trim().toLowerCase()
    return sources
      .filter(source => matches(source, q))
      .sort(
        (a, b) =>
          localizeData(a.name).localeCompare(localizeData(b.name), undefined, { sensitivity: "base" }) ||
          a.id.localeCompare(b.id)
      )
  }, [sources, query])

  /** Tables open their table page; rasters open on the map. */
  function open(source: DataSource) {
    window.location.hash = source.kind === "raster" ? `#/layer/${source.id}` : `#/table/${source.id}`
  }

  return (
    <main className="list-page">
      <h1>{T`Data`}</h1>
      {error && <div className="error">{error}</div>}
      {sources === null ? (
        <p>{T`Loading…`}</p>
      ) : sources.length === 0 ? (
        <p>
          {T`No data yet. Data sources appear here once an ${<a href="#/integrations">{T`integration`}</a>} runs.`}
        </p>
      ) : (
        <>
          <div className="new-session">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={T`Search sources`}
              aria-label={T`Search sources`}
            />
          </div>
          {shown.length === 0 ? (
            <p className="dim">{T`No sources match.`}</p>
          ) : (
            <table className="sessions">
              <thead>
                <tr><th>{T`Source`}</th><th>{T`Kind`}</th><th>{T`Contents`}</th><th>{T`Updated`}</th></tr>
              </thead>
              <tbody>
                {shown.map(source => (
                  <tr key={`${source.kind}:${source.id}`} onClick={() => open(source)}>
                    <td>
                      <b>{localizeData(source.name)}</b>
                      {source.description && <div className="source-description">{localizeData(source.description)}</div>}
                      <div className="source-from">{T`from ${localizeData(source.integrationName)}`}</div>
                    </td>
                    <td><span className={`chip chip-${source.kind}`}>{kindLabel(source.kind)}</span></td>
                    <td>
                      {source.kind === "table"
                        ? source.rows === null
                          ? T`no data yet`
                          : T`${source.rows.toLocaleString()} rows · ${source.columns} columns`
                        : source.snapshots === 1
                          ? T`${source.snapshots} snapshot`
                          : T`${source.snapshots} snapshots`}
                    </td>
                    <td>{source.updatedAt ? formatDateTime(source.updatedAt) : <span className="dim">{T`never`}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  )
}

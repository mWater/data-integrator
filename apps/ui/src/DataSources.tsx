import { useEffect, useState } from "react"
import { DataSource, listSources } from "./api.js"

/** A source kind's display label, translated at call time. */
function kindLabel(kind: DataSource["kind"]): string {
  return kind === "table" ? T`table` : T`raster`
}

/** Landing page: the data catalog — every table and raster layer on the server. */
export function DataSources() {
  const [sources, setSources] = useState<DataSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSources().then(r => setSources(r.sources), err => setError(err.message))
  }, [])

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
        <table className="sessions">
          <thead>
            <tr><th>{T`Source`}</th><th>{T`Kind`}</th><th>{T`Contents`}</th><th>{T`Updated`}</th></tr>
          </thead>
          <tbody>
            {sources.map(source => (
              <tr key={`${source.kind}:${source.id}`} onClick={() => open(source)}>
                <td>
                  <b>{source.name}</b>
                  {source.description && <div className="source-description">{source.description}</div>}
                  <div className="source-from">{T`from ${source.integrationName}`}</div>
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
                <td>{source.updatedAt ? new Date(source.updatedAt).toLocaleString() : <span className="dim">{T`never`}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

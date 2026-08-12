import { useEffect, useState } from "react"
import { DataSource, listSources } from "./api.js"

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
      <h1>Data</h1>
      {error && <div className="error">{error}</div>}
      {sources === null ? (
        <p>Loading…</p>
      ) : sources.length === 0 ? (
        <p>
          No data yet. Data sources appear here once an <a href="#/integrations">integration</a> runs.
        </p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>Source</th><th>Kind</th><th>Contents</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {sources.map(source => (
              <tr key={`${source.kind}:${source.id}`} onClick={() => open(source)}>
                <td>
                  <b>{source.name}</b>
                  <div className="dim">
                    {source.kind === "table" ? source.id + " · " : ""}from {source.integrationName}
                  </div>
                </td>
                <td><span className={`chip chip-${source.kind}`}>{source.kind}</span></td>
                <td>
                  {source.kind === "table"
                    ? source.rows === null
                      ? "no data yet"
                      : `${source.rows.toLocaleString()} rows · ${source.columns} columns`
                    : `${source.snapshots} snapshot${source.snapshots === 1 ? "" : "s"}`}
                </td>
                <td>{source.updatedAt ? new Date(source.updatedAt).toLocaleString() : <span className="dim">never</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

import { useEffect, useState } from "react"
import { createSession, getIntegration, IntegrationDetail } from "./api.js"
import { triggerLabel } from "./IntegrationList.js"

/** Props for the integration detail view. */
interface IntegrationViewProps {
  /** Integration to display */
  integrationId: string
  /** False for viewers: hides Design with Agent */
  canDesign: boolean
}

/** Detail tabs. */
type Tab = "runs" | "definition" | "code"

/** One installed integration: destinations, run history, definition, code. */
export function IntegrationView({ integrationId, canDesign }: IntegrationViewProps) {
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [tab, setTab] = useState<Tab>("runs")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getIntegration(integrationId).then(setDetail, err => setError(err.message))
  }, [integrationId])

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
  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{definition.name}</h1>
        <span className="chip">{definition.runtime}</span>
        <span className="chip">{triggerLabel(definition.trigger as { cron?: string })}</span>
        <span style={{ flex: 1 }} />
        {canDesign && <button onClick={onDesign}>Design with Agent</button>}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="dest-cards">
        {detail.destinations.map(d => (
          <div key={d.id} className="dest-card">
            <div className="dim">{d.kind === "table" ? "table" : "raster layer"}</div>
            <b>{d.id}</b>
            <div>{d.count === null ? "no data yet" : `${d.count.toLocaleString()} ${d.kind === "table" ? "rows" : "snapshots"}`}</div>
          </div>
        ))}
      </div>

      <div className="tabs">
        {(["runs", "definition", "code"] as Tab[]).map(t => (
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
      {tab === "definition" && (
        <pre className="pane pane-block">{JSON.stringify({ ...definition, code: undefined }, null, 2)}</pre>
      )}
      {tab === "code" && <pre className="pane pane-block pane-code">{definition.code}</pre>}
    </main>
  )
}

/** Dashboards list page. */

import { useEffect, useState } from "react"
import { createDashboardSession, DashboardSummary, deleteDashboard, listDashboards } from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { ConfirmDelete } from "./ConfirmDelete.js"

/** Props for the dashboards list. */
interface Props {
  /** True when the user may start design sessions */
  canDesign: boolean
}

/** Lists saved dashboards; new ones are created in design sessions. */
export function DashboardList({ canDesign }: Props) {
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [doomed, setDoomed] = useState<DashboardSummary | null>(null)

  useEffect(() => {
    listDashboards().then((r) => setDashboards(r.dashboards), (e: Error) => setError(e.message))
  }, [])

  async function newDashboard(dashboardId?: string) {
    if (!(await ensureAiAck())) return
    try {
      const { sessionId } = await createDashboardSession(dashboardId)
      window.location.hash = `#/session/${sessionId}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirmDelete(dashboard: DashboardSummary) {
    setError(null)
    try {
      await deleteDashboard(dashboard.id)
      setDoomed(null)
      setDashboards((list) => (list ?? []).filter((d) => d.id !== dashboard.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="list-page">
      <div className="new-session">
        <h1>{T`Dashboards`}</h1>
        {canDesign ? <button onClick={() => void newDashboard()}>{T`New Dashboard`}</button> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {dashboards && dashboards.length === 0 ? (
        <p className="dim">
          {canDesign ? T`No dashboards yet. Create one with the designer agent.` : T`No dashboards yet.`}
        </p>
      ) : null}
      {dashboards && dashboards.length > 0 ? (
        <table className="sessions">
          <thead>
            <tr>
              <th>{T`Name`}</th>
              <th>{T`Version`}</th>
              <th>{T`Updated`}</th>
              {canDesign ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {dashboards.map((d) => (
              <tr key={d.id}>
                <td>
                  <a href={`#/dashboard/${d.id}`}>{d.name}</a>
                </td>
                <td>{d.currentVersion ?? "—"}</td>
                <td>{new Date(d.updatedAt).toLocaleString()}</td>
                {canDesign ? (
                  <td className="row-actions">
                    <button className="secondary" onClick={() => void newDashboard(d.id)}>
                      {T`Edit with Agent`}
                    </button>
                    <button className="danger" onClick={() => setDoomed(d)}>
                      {T`Delete`}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {doomed ? (
        <ConfirmDelete
          title={T`Delete “${doomed.name}”?`}
          confirmToken={doomed.id}
          onCancel={() => setDoomed(null)}
          onConfirm={() => void confirmDelete(doomed)}
        >
          <p>
            {T`This permanently deletes the dashboard and all ${doomed.currentVersion ?? 0} of its saved versions. Anyone with a link to it will get a 404.`}{" "}
            <b>{T`This cannot be undone.`}</b>
          </p>
          <p className="dim">{T`Design sessions that built it are kept, with their link to this dashboard cleared.`}</p>
        </ConfirmDelete>
      ) : null}
    </main>
  )
}

/** Dashboards list page. */

import { useEffect, useState } from "react"
import { createDashboardSession, DashboardSummary, deleteDashboard, listDashboards } from "./api.js"
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
        <h1>Dashboards</h1>
        {canDesign ? <button onClick={() => void newDashboard()}>New Dashboard</button> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {dashboards && dashboards.length === 0 ? (
        <p className="dim">No dashboards yet.{canDesign ? " Create one with the designer agent." : ""}</p>
      ) : null}
      {dashboards && dashboards.length > 0 ? (
        <table className="sessions">
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>Updated</th>
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
                      Edit with Agent
                    </button>
                    <button className="danger" onClick={() => setDoomed(d)}>
                      Delete
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
          title={`Delete “${doomed.name}”?`}
          confirmToken={doomed.id}
          onCancel={() => setDoomed(null)}
          onConfirm={() => void confirmDelete(doomed)}
        >
          <p>
            This permanently deletes the dashboard and all {doomed.currentVersion ?? 0} of its saved versions. Anyone
            with a link to it will get a 404. <b>This cannot be undone.</b>
          </p>
          <p className="dim">Design sessions that built it are kept, with their link to this dashboard cleared.</p>
        </ConfirmDelete>
      ) : null}
    </main>
  )
}

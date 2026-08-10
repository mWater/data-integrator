/** Dashboards list page. */

import { useEffect, useState } from "react"
import { createDashboardSession, DashboardSummary, deleteDashboard, listDashboards } from "./api.js"

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
        <DeleteDialog dashboard={doomed} onCancel={() => setDoomed(null)} onConfirm={() => void confirmDelete(doomed)} />
      ) : null}
    </main>
  )
}

/** Props for the delete confirmation. */
interface DeleteDialogProps {
  /** Dashboard about to be deleted */
  dashboard: DashboardSummary
  /** Dismisses without deleting */
  onCancel: () => void
  /** Proceeds with the delete */
  onConfirm: () => void
}

/**
 * Delete confirmation: names the consequences and requires typing the
 * dashboard's id, so an irreversible delete cannot happen on a stray click.
 */
function DeleteDialog({ dashboard, onCancel, onConfirm }: DeleteDialogProps) {
  const [typed, setTyped] = useState("")
  const armed = typed.trim() === dashboard.id
  return (
    <>
      <div className="drawer-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={`Delete ${dashboard.name}`}>
        <h2>Delete “{dashboard.name}”?</h2>
        <p>
          This permanently deletes the dashboard and all {dashboard.currentVersion ?? 0} of its saved versions. Anyone
          with a link to it will get a 404. <b>This cannot be undone.</b>
        </p>
        <p className="dim">Design sessions that built it are kept, with their link to this dashboard cleared.</p>
        <label>
          <span>
            Type <code>{dashboard.id}</code> to confirm:
          </span>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && armed) onConfirm()
              if (e.key === "Escape") onCancel()
            }}
          />
        </label>
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" disabled={!armed} onClick={onConfirm}>
            Delete Forever
          </button>
        </div>
      </div>
    </>
  )
}

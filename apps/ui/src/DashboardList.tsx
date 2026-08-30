/** Dashboards list page. */

import { useEffect, useState } from "react"
import {
  createDashboardSession,
  DashboardSummary,
  deleteDashboard,
  listDashboards,
  renameDashboard,
  setDashboardPublic
} from "./api.js"
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
  const [renaming, setRenaming] = useState<DashboardSummary | null>(null)

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

  async function togglePublic(dashboard: DashboardSummary) {
    setError(null)
    try {
      const { public: isPublic } = await setDashboardPublic(dashboard.id, !dashboard.public)
      setDashboards((list) => (list ?? []).map((d) => (d.id === dashboard.id ? { ...d, public: isPublic } : d)))
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
              <th>{T`Sharing`}</th>
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
                <td>
                  {d.public ? (
                    <span className="chip chip-public" title={T`Anyone with the link can view this dashboard without signing in`}>
                      {T`public`}
                    </span>
                  ) : (
                    <span className="dim">{T`private`}</span>
                  )}
                </td>
                {canDesign ? (
                  <td className="row-actions">
                    <button className="secondary" onClick={() => void togglePublic(d)}>
                      {d.public ? T`Make Private` : T`Make Public`}
                    </button>
                    <button className="secondary" onClick={() => setRenaming(d)}>
                      {T`Rename`}
                    </button>
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
      {renaming ? (
        <RenameDialog
          dashboard={renaming}
          onCancel={() => setRenaming(null)}
          onRenamed={(oldId, newId, name) => {
            setRenaming(null)
            setDashboards((list) => (list ?? []).map((d) => (d.id === oldId ? { ...d, id: newId, name } : d)))
          }}
        />
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

/** Rename dialog: display name plus the URL slug, warning that links break. */
function RenameDialog({
  dashboard,
  onCancel,
  onRenamed
}: {
  /** Dashboard being renamed */
  dashboard: DashboardSummary
  /** Dismisses without renaming */
  onCancel: () => void
  /** Called with (oldId, newId, name) after a successful rename */
  onRenamed: (oldId: string, newId: string, name: string) => void
}) {
  const [name, setName] = useState(dashboard.name)
  const [slug, setSlug] = useState(dashboard.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const slugChanged = slug.trim() !== dashboard.id

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const { id } = await renameDashboard(dashboard.id, slug.trim(), name.trim())
      onRenamed(dashboard.id, id, name.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`Rename “${dashboard.name}”`}>
        <h2>{T`Rename “${dashboard.name}”`}</h2>
        <label>
          <span>{T`Name`}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{T`URL slug`}</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} />
        </label>
        {slugChanged ? (
          <p className="dim">
            {T`Changing the slug changes the dashboard's address to #/dashboard/${slug.trim()}. Existing links - including shared public ones - will stop working.`}
          </p>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            {T`Cancel`}
          </button>
          <button onClick={() => void submit()} disabled={busy || !name.trim() || !slug.trim()}>
            {T`Rename`}
          </button>
        </div>
      </div>
    </>
  )
}

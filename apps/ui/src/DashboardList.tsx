import { LoadState } from "./LoadState.js"
/** Dashboards list page. */

import { useEffect, useState } from "react"
import {
  createDashboardSession,
  DashboardSummary,
  deleteDashboard,
  listDashboards,
  listSessions,
  renameDashboard,
  SessionSummary,
  setDashboardPublic
} from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { ConfirmDelete } from "./ConfirmDelete.js"
import { RowMenu } from "./RowMenu.js"
import { formatDateTime } from "./localization.js"

/** Props for the dashboards list. */
interface Props {
  /** True when the user may start design sessions */
  canDesign: boolean
  /** True for admins: making a dashboard public is theirs alone */
  isAdmin: boolean
}

/** Lists saved dashboards; new ones are created in design sessions. */
export function DashboardList({ canDesign, isAdmin }: Props) {
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null)
  const [drafts, setDrafts] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [doomed, setDoomed] = useState<DashboardSummary | null>(null)
  const [renaming, setRenaming] = useState<DashboardSummary | null>(null)

  useEffect(() => {
    setError(null)
    listDashboards().then((r) => setDashboards(r.dashboards), (e: Error) => setError(e.message))
    // A dashboard only gets a row once its creator saves it; until then the
    // draft lives in its design session, listed here so it is not mistaken for
    // lost. Edits to a saved dashboard list here too until they are saved
    listSessions().then(
      (r) =>
        setDrafts(
          r.sessions.filter(
            (s) =>
              s.kind === "dashboard" &&
              // Sessions opened and never used are not drafts worth listing
              (s.unsaved || (!s.integrationId && s.status !== "finished" && (s.steps > 0 || s.firstMessage)))
          )
        ),
      () => {}
    )
  }, [retry])

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

  function openDashboard(id: string) {
    window.location.hash = `#/dashboard/${id}`
  }

  return (
    <main className="list-page">
      <div className="list-head">
        <h1>{T`Dashboards`}</h1>
        {canDesign ? (
          <button onClick={() => void newDashboard()}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M6 1.5v9M1.5 6h9" />
            </svg>
            {T`New Dashboard`}
          </button>
        ) : null}
      </div>
      {error && dashboards !== null ? <div className="error" role="alert">{error}</div> : null}
      {dashboards === null ? (
        <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
      ) : dashboards.length === 0 && drafts.length === 0 ? (
        <p>
          {canDesign ? T`No dashboards yet. Create one with the designer agent.` : T`No dashboards yet.`}
        </p>
      ) : (
        <>
          {drafts.length > 0 && (
            <section className="draft-section" aria-label={T`Drafts`}>
              <h2 className="section-label">{T`Drafts`}</h2>
              <ul className="draft-list">
                {drafts.map((s) => (
                  <li key={s.id}>
                    <a className="draft-item" href={`#/session/${s.id}`}>
                      <span className="draft-main">
                        <span className="draft-title">{s.label || s.firstMessage || T`New dashboard`}</span>
                        <span className="draft-meta">
                          {s.unsaved
                            ? s.integrationId
                              ? T`Unsaved changes to a saved dashboard`
                              : T`Not saved yet`
                            : T`Being designed`}
                          {s.userEmail ? ` · ${s.userEmail}` : ""} · {formatDateTime(s.updatedAt)}
                        </span>
                      </span>
                      <span className="draft-open">{T`Continue`} →</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {drafts.length > 0 && dashboards.length > 0 && <h2 className="section-label">{T`Saved`}</h2>}
          {dashboards.length > 0 && (
            <table className="sessions dashboard-table">
              <thead>
                <tr>
                  <th>{T`Name`}</th>
                  <th>{T`Updated`}</th>
                  {canDesign ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {dashboards.map((d) => (
                  <tr key={d.id} onClick={() => openDashboard(d.id)}>
                    <td>
                      <a className="dashboard-name" href={`#/dashboard/${d.id}`} onClick={e => e.stopPropagation()}>{d.name}</a>
                      {d.public ? (
                        <span
                          className="chip chip-public"
                          title={
                            d.publishedBy
                              ? T`Anyone with the link can view this dashboard without signing in. Made public by ${d.publishedBy} on ${formatDateTime(d.publishedAt)}.`
                              : T`Anyone with the link can view this dashboard without signing in`
                          }
                        >
                          {T`public`}
                        </span>
                      ) : null}
                      <div className="dim slug">#/dashboard/{d.id}</div>
                    </td>
                    <td className="dim">{formatDateTime(d.updatedAt)}</td>
                    {canDesign ? (
                      <td className="row-delete-cell">
                        <RowMenu label={T`Actions for ${d.name}`}>
                          <button role="menuitem" onClick={() => void newDashboard(d.id)}>
                            {T`Edit with Agent`}
                          </button>
                          {isAdmin && (
                            <button role="menuitem" onClick={() => void togglePublic(d)}>
                              {d.public ? T`Make Private` : T`Make Public`}
                            </button>
                          )}
                          <button role="menuitem" onClick={() => setRenaming(d)}>
                            {T`Rename`}
                          </button>
                          <button role="menuitem" className="row-menu-danger" onClick={() => setDoomed(d)}>
                            {T`Delete`}
                          </button>
                        </RowMenu>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
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

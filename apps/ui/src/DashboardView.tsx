import { LoadState } from "./LoadState.js"
/** Full-page dashboard viewer: a slim toolbar over the sandboxed frame. */

import { useEffect, useRef, useState } from "react"
import {
  createDashboardSession,
  DashboardDetail,
  DashboardSource,
  DashboardVersionSummary,
  getDashboard,
  getDashboardSources,
  getDashboardVersions,
  restoreDashboardVersion
} from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { DashboardFrame } from "./DashboardFrame.js"
import { formatDateTime, localizeData } from "./localization.js"

/** Props for the dashboard viewer. */
interface Props {
  /** Dashboard id from the route */
  dashboardId: string
  /** True when the signed-in user may open a design session on it */
  canDesign: boolean
}

/** Renders a saved dashboard in its sandboxed frame. */
export function DashboardView({ dashboardId, canDesign }: Props) {
  const [detail, setDetail] = useState<DashboardDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const printRef = useRef<(() => void) | null>(null)
  const [restoring, setRestoring] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setDetail(null)
    getDashboard(dashboardId).then(d => { if (!cancelled) setDetail(d) }, (e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [dashboardId, retry])

  async function edit() {
    setError(null)
    if (!(await ensureAiAck())) return
    try {
      const { sessionId } = await createDashboardSession(dashboardId)
      window.location.hash = `#/session/${sessionId}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (error) return <main className="list-page"><a className="page-back" href="#/dashboards">← {T`Dashboards`}</a><LoadState error={error} onRetry={() => setRetry(n => n + 1)} /></main>
  if (!detail) return <main className="list-page"><LoadState onRetry={() => setRetry(n => n + 1)} /></main>

  return (
    <main className="dashboard-page">
      <div className="dashboard-toolbar">
        <a className="page-back" href="#/dashboards">← {T`Dashboards`}</a>
        <h1>{detail.name}</h1>
        {detail.public && <span className="chip chip-public">{T`public`}</span>}
        <span className="spacer" />
        <SourcesMenu dashboardId={dashboardId} />
        {canDesign && (
          <HistoryMenu dashboardId={dashboardId} currentVersion={detail.currentVersion} onRestore={setRestoring} />
        )}
        <button className="secondary" onClick={() => printRef.current?.()} title={T`Print, or save as PDF from the print dialog`}>
          {T`Print`}
        </button>
        {canDesign && (
          <button onClick={() => void edit()}>{T`Edit with Agent`}</button>
        )}
      </div>
      <DashboardFrame
        dashboardId={detail.id}
        bundleJs={detail.bundleJs}
        bundleCss={detail.bundleCss}
        onPrintReady={print => (printRef.current = print)}
      />
      {restoring !== null && (
        <RestoreDialog
          detail={detail}
          version={restoring}
          onCancel={() => setRestoring(null)}
          onRestored={restored => {
            setRestoring(null)
            setDetail(restored)
          }}
        />
      )}
    </main>
  )
}

/**
 * "Sources" button opening the list of tables and layers the dashboard reads,
 * each linking to its catalog page. Fetched on first open.
 */
function SourcesMenu({ dashboardId }: { dashboardId: string }) {
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<DashboardSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    if (sources === null) getDashboardSources(dashboardId).then(r => setSources(r.sources), e => setError(e.message))
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, sources, dashboardId])

  return (
    <div className="sources-menu" ref={ref}>
      <button className="secondary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {T`Sources`}
      </button>
      {open && (
        <div className="sources-popover" role="dialog" aria-label={T`Data sources used by this dashboard`}>
          <h2>{T`Data sources`}</h2>
          {error ? (
            <div className="error">{error}</div>
          ) : sources === null ? (
            <p className="dim">{T`Loading…`}</p>
          ) : sources.length === 0 ? (
            <p className="dim">{T`No catalog sources found in this dashboard's queries.`}</p>
          ) : (
            <ul>
              {sources.map(s => (
                <li key={`${s.kind}:${s.id}`}>
                  <a href={s.kind === "raster" ? `#/layer/${s.id}` : `#/table/${s.id}`}>{localizeData(s.name)}</a>
                  <span className={`chip chip-${s.kind}`}>{s.kind === "raster" ? T`raster` : T`table`}</span>
                  {s.description && <div className="dim">{localizeData(s.description)}</div>}
                  <div className="dim">
                    {T`From ${(<a key="integration" href={`#/integration/${s.integrationId}`}>{localizeData(s.integrationName)}</a>)}`}
                    {s.updatedAt ? ` · ${T`updated ${formatDateTime(s.updatedAt)}`}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Props for the version history menu. */
interface HistoryMenuProps {
  /** Dashboard whose versions are listed */
  dashboardId: string
  /** The version everyone sees now */
  currentVersion: number | null
  /** Asks to restore a version (the caller confirms) */
  onRestore: (version: number) => void
}

/**
 * "History" button opening the dashboard's saved versions, newest first, each
 * but the current one restorable. Fetched on each open, so a restore shows.
 */
function HistoryMenu({ dashboardId, currentVersion, onRestore }: HistoryMenuProps) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<DashboardVersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    getDashboardVersions(dashboardId).then(r => setVersions(r.versions), e => setError(e.message))
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, dashboardId, currentVersion])

  return (
    <div className="sources-menu" ref={ref}>
      <button className="secondary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {T`History`}
      </button>
      {open && (
        <div className="sources-popover" role="dialog" aria-label={T`Saved versions of this dashboard`}>
          <h2>{T`Saved versions`}</h2>
          {error ? (
            <div className="error">{error}</div>
          ) : versions === null ? (
            <p className="dim">{T`Loading…`}</p>
          ) : (
            <ul className="version-list">
              {versions.map(v => (
                <li key={v.version}>
                  <div>
                    <b>{T`v${v.version}`}</b>
                    {v.version === currentVersion && <span className="chip chip-certified">{T`current`}</span>}
                    <div className="dim">
                      {formatDateTime(v.createdAt)}
                      {v.createdBy ? ` · ${v.createdBy}` : ""}
                    </div>
                    {v.restoredFrom !== null && <div className="dim">{T`Restored from v${v.restoredFrom}`}</div>}
                  </div>
                  {v.version !== currentVersion && (
                    <button
                      className="secondary"
                      onClick={() => {
                        setOpen(false)
                        onRestore(v.version)
                      }}
                    >
                      {T`Restore`}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Props for the restore confirmation. */
interface RestoreDialogProps {
  /** The dashboard at its current version */
  detail: DashboardDetail
  /** Version to restore */
  version: number
  /** Dismisses without restoring */
  onCancel: () => void
  /** Called with the dashboard at its new current version */
  onRestored: (detail: DashboardDetail) => void
}

/** Confirms restoring a version, which saves a copy of it as the new current version. */
function RestoreDialog({ detail, version, onCancel, onRestored }: RestoreDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await restoreDashboardVersion(detail.id, version)
      onRestored(await getDashboard(detail.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`Restore version ${version}`}>
        <h2>{T`Restore version ${version}?`}</h2>
        <p>
          {T`This saves a copy of version ${version} as the new current version, which everyone signed in sees right away. Version ${detail.currentVersion ?? ""} stays in the history, so you can restore it later.`}
        </p>
        {detail.public && (
          <p>
            <b>{T`This dashboard is public: anyone with its link sees the restored version.`}</b>
          </p>
        )}
        <p>{T`Design sessions open on this dashboard keep their drafts, which then count as unsaved changes.`}</p>
        {error ? <div className="error">{error}</div> : null}
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            {T`Cancel`}
          </button>
          <button onClick={() => void confirm()} disabled={busy}>
            {busy ? T`Restoring…` : T`Restore`}
          </button>
        </div>
      </div>
    </>
  )
}

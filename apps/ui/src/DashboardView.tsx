/** Full-page dashboard viewer: a slim toolbar over the sandboxed frame. */

import { useEffect, useRef, useState } from "react"
import { createDashboardSession, DashboardDetail, DashboardSource, getDashboard, getDashboardSources } from "./api.js"
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
  const printRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    getDashboard(dashboardId).then(setDetail, (e: Error) => setError(e.message))
  }, [dashboardId])

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

  if (error) return <main className="list-page"><p className="error">{error}</p></main>
  if (!detail) return null

  return (
    <main className="dashboard-page">
      <div className="dashboard-toolbar">
        <h1>{detail.name}</h1>
        {detail.public && <span className="chip chip-public">{T`public`}</span>}
        <span className="spacer" />
        <SourcesMenu dashboardId={dashboardId} />
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

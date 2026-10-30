import { LoadState } from "./LoadState.js"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createSession, importIntegration, IntegrationSummary, listIntegrations, listSessions, SessionSummary } from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { cronText, formatDateTime, localizeData } from "./localization.js"

/** Human-readable trigger summary. */
export function triggerLabel(trigger: { cron?: string; webhook?: boolean }): string {
  const parts = []
  if (trigger.cron) parts.push(cronText(trigger.cron))
  if (trigger.webhook) parts.push(T`webhook`)
  return parts.join(" + ") || T`manual`
}

/** Keep failures distinct from integrations deliberately paused by an editor. */
function needsAttention(i: IntegrationSummary): boolean {
  return i.lastRunStatus === "failed" || i.lastRunStatus === "timeout"
}

function runLabel(status: string | null): string {
  switch (status) {
    case "succeeded": return T`Succeeded`
    case "failed": return T`Failed`
    case "timeout": return T`Timed Out`
    case "running": return T`Running`
    case "queued": return T`Queued`
    case "cancelled": return T`Cancelled`
    default: return status ?? T`Not Run Yet`
  }
}

/** Relative summaries keep exact timestamps available on hover. */
function runAge(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 1) return T`Just now`
  if (minutes < 60) return T`${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return T`${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? T`Yesterday` : T`${days}d ago`
}

/** Props for the integration list. */
interface IntegrationListProps {
  /** False for viewers: hides the new-integration flow */
  canDesign: boolean
}

/** Landing page: installed integrations plus the new-integration flow. */
export function IntegrationList({ canDesign }: IntegrationListProps) {
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null)
  const [drafts, setDrafts] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "attention" | "running" | "paused">("all")
  const fileInput = useRef<HTMLInputElement>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    setLoadError(null)
    try {
      const result = await listIntegrations()
      if (mounted.current) {
        setIntegrations(result.integrations)
        setCheckedAt(new Date().toISOString())
      }
    } catch (err) {
      if (mounted.current) setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      if (mounted.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  const hasActiveRuns = integrations?.some(i => i.lastRunStatus === "running" || i.lastRunStatus === "queued")
  useEffect(() => {
    const refreshVisible = () => { if (!document.hidden) void refresh() }
    const timer = setInterval(refreshVisible, hasActiveRuns ? 5000 : 30000)
    document.addEventListener("visibilitychange", refreshVisible)
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible) }
  }, [refresh, hasActiveRuns])


  useEffect(() => {
    // Design sessions still in progress show here as drafts, so a paused
    // session is found where its result would appear
    listSessions().then(
      // Sessions opened and never used are not drafts worth listing
      r =>
        setDrafts(
          r.sessions.filter(s => s.kind === "designer" && s.status !== "finished" && (s.steps > 0 || s.firstMessage))
        ),
      () => {}
    )
  }, [])

  // Drafts whose integration already has a row are reachable from that row
  const orphanDrafts = useMemo(
    () => drafts.filter(d => !d.integrationId || !(integrations ?? []).some(i => i.id === d.integrationId)),
    [drafts, integrations]
  )

  const sortedIntegrations = useMemo(
    () =>
      (integrations ?? [])
        .slice()
        .sort(
          (a, b) =>
            localizeData(a.name).localeCompare(localizeData(b.name), undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id, undefined, { sensitivity: "base" })
        ),
    [integrations]
  )

  // Drafts get their own section up top; the status filters cover ready ones
  const ready = sortedIntegrations.filter(i => i.status !== "draft")
  const draftIntegrations = sortedIntegrations.filter(i => i.status === "draft")
  const matchesFilter = (i: IntegrationSummary) => filter === "all" ||
    (filter === "attention" ? needsAttention(i) : filter === "paused" ? !i.enabled : i.lastRunStatus === "running" || i.lastRunStatus === "queued")
  const q = query.trim().toLowerCase()
  const matchesQuery = (i: IntegrationSummary) =>
    [localizeData(i.name), localizeData(i.description), i.id].some(text => text.toLowerCase().includes(q))
  const shown = ready.filter(i => matchesFilter(i) && matchesQuery(i))
  const showDrafts = filter === "all"
  const shownDraftIntegrations = showDrafts ? draftIntegrations.filter(matchesQuery) : []
  const shownDrafts = showDrafts ? orphanDrafts.filter(d => [d.integrationId, d.firstMessage].some(text => (text ?? "").toLowerCase().includes(q))) : []
  const draftCount = shownDraftIntegrations.length + shownDrafts.length
  // Matching drafts are results enough; the empty notice is for no results at all
  const showEmpty = shown.length === 0 && draftCount === 0

  function integrationEntry(i: IntegrationSummary) {
    return <article className="catalog-entry integration-entry" key={i.id}>
      <div className="catalog-copy">
        <div className="catalog-name"><a href={`#/integration/${i.id}`}>{localizeData(i.name)}</a>
          {i.status === "draft" && <span className="chip chip-draft">{T`Draft`}</span>}
          {!i.enabled && <span className="chip chip-paused">{T`Paused`}</span>}
        </div>
        {i.description && <p className="catalog-description">{localizeData(i.description)}</p>}
        <span className="catalog-schedule">{T`Schedule:`} {triggerLabel(i.trigger)}</span>
      </div>
      <div className="catalog-meta">
        <span className="catalog-date-label">{T`Latest run`}</span>
        <span className={`chip chip-${i.lastRunStatus ?? "idle"}`}>{runLabel(i.lastRunStatus)}</span>
        {i.lastRunAt && <time dateTime={i.lastRunAt} title={formatDateTime(i.lastRunAt)}>{runAge(i.lastRunAt)}</time>}
      </div>
      <a className="catalog-open" href={`#/integration/${i.id}`}>{T`Open Integration`} <span aria-hidden="true">→</span></a>
    </article>
  }

  /** Imports a definition file exported by another deployment; it lands paused. */
  async function onImportFile(file: File) {
    setError(null)
    try {
      const definition = JSON.parse(await file.text())
      const { id } = await importIntegration(definition)
      window.location.hash = `#/integration/${id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onCreate() {
    setError(null)
    if (!(await ensureAiAck())) return
    try {
      const { sessionId } = await createSession()
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="list-page catalog-page">
      <div className="list-head">
        <div className="catalog-header"><h1>{T`Integrations`}</h1><p>{T`Monitor runs and manage how your data stays current.`}</p></div>
        {canDesign && (
          <div className="list-head-actions">
            <button
              className="secondary"
              title={T`Install a definition file exported from another deployment; it arrives paused for review`}
              onClick={() => fileInput.current?.click()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 1.5v6M3.5 5 6 7.5 8.5 5M2 10.5h8" />
              </svg>
              {T`Import`}
            </button>
            <button onClick={onCreate}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 1.5v9M1.5 6h9" />
              </svg>
              {T`New Integration`}
            </button>
          </div>
        )}
      </div>
      {canDesign && (
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void onImportFile(file)
          }}
        />
      )}
      {error && <div className="error">{error}</div>}
      <div className="status-refresh">
        <span className="dim" role="status">{refreshing ? T`Checking status…` : checkedAt ? T`Status checked ${formatDateTime(checkedAt)}` : T`Status has not been checked yet`}</span>
        <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>{T`Refresh`}</button>
      </div>
      {loadError && integrations !== null && <LoadState error={loadError} onRetry={() => void refresh()} />}
      {integrations === null ? (
        <LoadState error={loadError} onRetry={() => void refresh()} />
      ) : integrations.length === 0 && orphanDrafts.length === 0 ? (
        <p>{T`Nothing installed yet. New Integration starts a design session; describe what to build there.`}</p>
      ) : (
        <>
          <div className="catalog-toolbar">
            <input type="search" aria-label={T`Search integrations`} placeholder={T`Search integrations`} value={query} onChange={e => setQuery(e.target.value)} />
            <div className="catalog-filters" role="group" aria-label={T`Filter integrations`}>
              {([
                ["all", T`All`, ready.length],
                ["attention", T`Needs Attention`, ready.filter(needsAttention).length],
                ["running", T`Running`, ready.filter(i => i.lastRunStatus === "running" || i.lastRunStatus === "queued").length],
                ["paused", T`Paused`, ready.filter(i => !i.enabled).length]
              ] as const).map(([value, label, count]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count}</span></button>)}
            </div>
          </div>
          {draftCount > 0 && <section className="catalog-drafts" aria-labelledby="catalog-drafts-heading">
            <h2 id="catalog-drafts-heading">{T`Drafts`} <span className="catalog-drafts-count">{draftCount}</span></h2>
            <div className="catalog-list">
              {shownDraftIntegrations.map(integrationEntry)}
              {shownDrafts.map(d => <article className="catalog-entry" key={d.id}>
                <div className="catalog-copy"><div className="catalog-name"><a href={`#/session/${d.id}`}>{d.integrationId ?? d.firstMessage ?? T`New integration`}</a></div>
                  <p className="catalog-description">{d.status === "paused" ? T`Design session paused, waiting for you` : T`Design session in progress`}</p>
                </div><a className="catalog-open" href={`#/session/${d.id}`}>{T`Continue Design`} <span aria-hidden="true">→</span></a>
              </article>)}
            </div>
          </section>}
          {(shown.length > 0 || showEmpty) && <p className="catalog-count" role="status">{shown.length === 1 ? T`1 integration` : T`${shown.length} integrations`}</p>}
          {showEmpty ? <div className="catalog-empty">
            <h2>{filter === "attention" && !q ? T`No failed runs` : T`No integrations found`}</h2>
            <p>{T`Try another search or view all integrations.`}</p>
            <button className="secondary" onClick={() => { setQuery(""); setFilter("all") }}>{T`Clear Filters`}</button>
          </div> : shown.length > 0 && <div className="catalog-list">{shown.map(integrationEntry)}</div>}
        </>

      )}
    </main>
  )
}

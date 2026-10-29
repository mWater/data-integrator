import { LoadState } from "./LoadState.js"
import { useEffect, useMemo, useState } from "react"
import {
  DefaultAoi,
  getLibraryEntry,
  getSettings,
  getSkill,
  installLibraryEntry,
  LibraryDefinition,
  LibraryEntry,
  listLibrary,
  listSkills,
  SkillDetail,
  SkillSummary,
  User
} from "./api.js"
import { triggerLabel } from "./IntegrationList.js"
import { Markdown } from "./Markdown.js"
import { localizeData } from "./localization.js"
import type { LocalizedString } from "ez-localize"

/**
 * The library's skills: source and technique know-how the design agent loads on
 * demand. Reference material rather than something to act on, so it sits quietly
 * below the installable entries and opens in place.
 */
function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, SkillDetail>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSkills().then(r => setSkills(r.skills), err => setError(err.message))
  }, [])

  function toggle(id: string) {
    if (open === id) {
      setOpen(null)
      return
    }
    setOpen(id)
    // Bodies are fetched once and kept, so reopening is instant
    if (!texts[id]) {
      getSkill(id).then(
        skill => setTexts(prev => ({ ...prev, [id]: skill })),
        err => setError(err.message)
      )
    }
  }

  if (skills !== null && skills.length === 0) return null

  return (
    <section className="skills-section">
      <h2>{T`Source Notes`}</h2>
      <p className="dim">
        {T`Reference material the designer uses to build integrations. Open a note to explore a source or technique.`}
      </p>
      {error && <div className="error">{error}</div>}
      {skills === null ? (
        <p className="dim">{T`Loading…`}</p>
      ) : (
        <ul className="skill-list">
          {skills.map(skill => {
            const expanded = open === skill.id
            const detail = texts[skill.id]
            return (
              <li className="skill" key={skill.id}>
                <button className="skill-head" aria-expanded={expanded} onClick={() => toggle(skill.id)}>
                  <span className="skill-caret" aria-hidden="true">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </span>
                  <span className="skill-name">{skill.name}</span>
                  <span className="skill-desc">{skill.description}</span>
                  {skill.verified && <span className="skill-verified">{T`checked ${skill.verified}`}</span>}
                </button>
                {expanded && (
                  <div className="skill-body">
                    {detail ? <Markdown text={detail.body} /> : <p className="dim">{T`Loading…`}</p>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Every language's text of a localized string, joined for searching. */
function allTranslations(value: LocalizedString | string | null | undefined): string {
  if (!value) return ""
  if (typeof value === "string") return value
  return Object.entries(value)
    .filter(([k]) => k !== "_base")
    .map(([, v]) => String(v))
    .join(" ")
}

/**
 * Human label for the entry's relationship to this deployment. Built per call
 * rather than once at module load, so a locale change reaches them.
 */
function statusLabels(): Record<LibraryEntry["status"], string> {
  return {
    not_installed: T`Not Installed`,
    installed: T`Installed`,
    update_available: T`Update Available`
  }
}

/**
 * What an entry produces and where it comes from: the declared tables with
 * their columns, the layers with their bands, and the source's provenance and
 * caveats. Shown in place when a row is clicked.
 */
function EntryDetail({ definition }: { definition: LibraryDefinition }) {
  const source = definition.source
  return (
    <div className="library-detail">
      {source && (
        <div className="library-detail-source">
          <b>{T`Source:`}</b> {localizeData(source.name)}
          {source.provider ? ` · ${source.provider}` : ""}
          {source.license ? ` · ${source.license}` : ""}
          {source.url && (
            <>
              {" · "}
              <a href={source.url} target="_blank" rel="noreferrer">
                {T`website`}
              </a>
            </>
          )}
          {source.documentation && (
            <>
              {" · "}
              <a href={source.documentation} target="_blank" rel="noreferrer">
                {T`documentation`}
              </a>
            </>
          )}
          {source.limitations && <p className="dim">{localizeData(source.limitations)}</p>}
        </div>
      )}
      {definition.destinations.map(d => (
        <div className="library-detail-dest" key={d.kind === "table" ? `t:${d.tableId}` : `r:${d.layerId}`}>
          <div>
            <span className={`chip ${d.kind === "table" ? "chip-table" : "chip-raster"}`}>
              {d.kind === "table" ? T`table` : d.temporality === "time-series" ? T`time-series layer` : T`layer`}
            </span>{" "}
            <b>{d.name ? localizeData(d.name) : d.kind === "table" ? d.tableId : d.layerId}</b>{" "}
            <span className="dim">{d.kind === "table" ? d.tableId : d.layerId}</span>
            {d.description && <div className="dim">{localizeData(d.description)}</div>}
          </div>
          <ul className="library-fields">
            {(d.kind === "table" ? d.columns : d.bands).map(f => (
              <li key={f.id}>
                {f.name ? localizeData(f.name) : f.id}
                <span className="dim">
                  {" "}
                  {f.id}
                  {d.kind === "table" && "type" in f ? ` · ${(f as { type: string }).type}` : ""}
                  {f.units ? ` · ${f.units}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** Summarize outputs without exposing storage identifiers in the catalog. */
function outputLabels(entry: LibraryEntry): string[] {
  const tables = entry.destinations.filter(d => d.kind === "table").length
  const layers = entry.destinations.length - tables
  return [
    tables ? (tables === 1 ? T`1 table` : T`${tables} tables`) : "",
    layers ? (layers === 1 ? T`1 raster layer` : T`${layers} raster layers`) : ""
  ].filter(Boolean)
}

/** Props for the Library page. */
interface LibraryProps {
  /** Signed-in user; viewers see the catalog without install controls */
  user: User
  /** Entry whose install confirmation opens on arrival (from an agent's install link) */
  installId?: string | null
}

/**
 * The integration library: every entry the deployment's library ships,
 * installable in one confirmation. Installing copies the entry's values into
 * the integration's definition; updating keeps the deployment-owned fields
 * (area of interest, schedule, limits).
 */
export function Library({ user, installId }: LibraryProps) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, LibraryDefinition>>({})
  const [defaultAoi, setDefaultAoi] = useState<DefaultAoi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [runNow, setRunNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState<{ id: string; version: number; ran: boolean } | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "installed" | "updates">("all")

  const canDesign = user.role !== "viewer"

  function refresh() {
    setError(null)
    listLibrary().then(r => setEntries(r.entries), err => setError(err.message))
  }

  useEffect(() => {
    refresh()
    getSettings().then(r => setDefaultAoi(r.settings.default_aoi), () => {})
  }, [])

  // An agent's install link lands with the entry named: open its confirmation
  // (editors) or its details (viewers) and bring it into view
  useEffect(() => {
    if (!installId || !entries) return
    const entry = entries.find(e => e.id === installId)
    if (!entry) return
    setQuery("")
    setFilter("all")
    if (canDesign && entry.status !== "installed") setConfirming(entry.id)
    else toggle(entry.id, true)
    setTimeout(() => document.getElementById(`library-${entry.id}`)?.scrollIntoView({ block: "center" }), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installId, entries === null])

  /** Opens or closes an entry's detail row, fetching the definition once. */
  function toggle(id: string, open?: boolean) {
    const next = open ?? expanded !== id
    setExpanded(next ? id : null)
    if (next && !details[id]) {
      getLibraryEntry(id).then(
        r => setDetails(prev => ({ ...prev, [id]: r.definition })),
        err => setError(err.message)
      )
    }
  }

  // Name, description, source and destination ids all count, in every language
  // the entry carries: entry names are often product codes, so "drought" (or
  // "seca") has to find the SPI-3 entry whatever the interface language
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries ?? []).filter(entry =>
      (filter === "all" || (filter === "installed" ? entry.status !== "not_installed" : entry.status === "update_available")) &&
      (!q ||
      [
        entry.id,
        allTranslations(entry.name),
        allTranslations(entry.description),
        entry.source?.provider ?? "",
        allTranslations(entry.source?.name),
        ...entry.destinations.map(d => d.id)
      ]
        .join(" ")
        .toLowerCase()
        .includes(q))
    )
  }, [entries, query, filter])

  async function install(entry: LibraryEntry) {
    setBusy(true)
    setError(null)
    try {
      const result = await installLibraryEntry(entry.id, runNow)
      setInstalled({ id: entry.id, version: result.version, ran: result.runId !== null })
      setConfirming(null)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="list-page library-page">
      <header className="library-header">
        <h1>{T`Library`}</h1>
        <p>{T`Ready-made integrations to bring new data into your deployment.`}</p>
      </header>
      {error && entries !== null && <div className="error" role="alert">{error}</div>}
      {installed && (
        <p className="library-notice" role="status">
          {installed.ran
            ? T`Installed ${<a href={`#/integration/${installed.id}`}>{installed.id}</a>} (v${installed.version}); first ingest started.`
            : T`Installed ${<a href={`#/integration/${installed.id}`}>{installed.id}</a>} (v${installed.version}).`}
        </p>
      )}
      {entries === null ? (
        <LoadState error={error} onRetry={refresh} />
      ) : entries.length === 0 ? (
        <p>{T`This deployment has no library configured.`}</p>
      ) : (
        <>
        <div className="library-toolbar">
          <input
            type="search"
            disabled={busy}
            value={query}
            onChange={e => { setQuery(e.target.value); setConfirming(null) }}
            placeholder={T`Search the library`}
            aria-label={T`Search the library`}
          />
          <div className="library-filters" role="group" aria-label={T`Filter integrations`}>
            {([
              ["all", T`All`, entries.length],
              ["installed", T`Installed`, entries.filter(e => e.status !== "not_installed").length],
              ["updates", T`Updates`, entries.filter(e => e.status === "update_available").length]
            ] as const).map(([value, label, count]) => (
              <button key={value} type="button" aria-pressed={filter === value} disabled={busy} onClick={() => { setFilter(value); setConfirming(null) }}>
                {label} <span>{count}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="library-result-count" role="status">{shown.length === 1 ? T`1 integration` : T`${shown.length} integrations`}</p>
        {shown.length === 0 ? (
          <div className="library-empty">
            <h2>{filter === "updates" && !query.trim() ? T`Everything is up to date` : T`No integrations found`}</h2>
            <p>{T`Try another search or view all integrations.`}</p>
            <button className="secondary" onClick={() => { setQuery(""); setFilter("all"); setConfirming(null) }}>{T`Clear Filters`}</button>
          </div>
        ) : (
        <div className="library-entries">
            {shown.map(entry => (
              <article key={entry.id} id={`library-${entry.id}`} className="library-entry">
                <div className="library-entry-summary">
                  <button
                    className="library-entry-toggle"
                    aria-label={localizeData(entry.name)}
                    aria-expanded={expanded === entry.id}
                    aria-controls={`library-detail-${entry.id}`}
                    onClick={() => toggle(entry.id)}
                  >
                    <svg className="library-caret" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    <span className="library-entry-copy">
                      <span className="library-entry-name">{localizeData(entry.name)}</span>
                      {entry.description && <span className="library-entry-description">{localizeData(entry.description)}</span>}
                      <span className="library-entry-outputs">
                        {outputLabels(entry).map(label => <span key={label}>{label}</span>)}
                        <span className="library-detail-hint">{expanded === entry.id ? T`Hide details` : T`View details`}</span>
                      </span>
                    </span>
                  </button>
                  <div className="library-entry-actions">
                    {entry.status !== "not_installed" && <span className={`chip ${entry.status === "installed" ? "chip-finished" : "chip-paused"}`}>{statusLabels()[entry.status]}</span>}
                    {canDesign && entry.status !== "installed" ? (
                      <button disabled={busy} aria-expanded={confirming === entry.id} aria-controls={confirming === entry.id ? `library-confirm-${entry.id}` : undefined} onClick={() => { setConfirming(confirming === entry.id ? null : entry.id); setInstalled(null) }}>
                        {entry.status === "not_installed" ? T`Install` : T`Update`}
                      </button>
                    ) : entry.status !== "not_installed" ? (
                      <a href={`#/integration/${entry.id}`}>{T`Open Integration`} <span aria-hidden="true">→</span></a>
                    ) : <span className="dim">{statusLabels()[entry.status]}</span>}
                  </div>
                </div>
                <div id={`library-detail-${entry.id}`} hidden={expanded !== entry.id} className="library-entry-detail">
                  {expanded === entry.id && <>
                    {entry.description && <p className="library-full-description">{localizeData(entry.description)}</p>}
                    <dl className="library-entry-facts">
                      <div><dt>{T`Default schedule`}</dt><dd>{triggerLabel(entry.trigger)}</dd></div>
                      {entry.installedVersion !== null && <div><dt>{T`Installed version`}</dt><dd>{entry.installedVersion}</dd></div>}
                    </dl>
                    {details[entry.id] ? <EntryDetail definition={details[entry.id]} /> : <p className="dim">{T`Loading…`}</p>}
                  </>}
                </div>
                {confirming === entry.id && (
                  <div id={`library-confirm-${entry.id}`} className="library-confirm-body" role="region" aria-label={T`Confirm installation`}>
                    <h3>{entry.status === "update_available" ? T`Update integration` : T`Install integration`}</h3>
                    <div>
                      <b>{T`Schedule:`}</b> {entry.status === "update_available" ? T`Keeps your current schedule` : triggerLabel(entry.trigger)}
                      {entry.status !== "update_available" && entry.trigger.cron ? <span className="dim"> {T`(cron ${entry.trigger.cron})`}</span> : null}
                    </div>
                    <div>
                      <b>{T`Area of interest:`}</b>{" "}
                      {entry.status === "update_available" ? (
                        <span>{T`unchanged — keeps the installed integration's area`}</span>
                      ) : defaultAoi ? (
                        <span>
                          {T`deployment default — ${defaultAoi.name ?? T`custom`} [${defaultAoi.bbox.map(v => v.toFixed(2)).join(", ")}]`}
                        </span>
                      ) : (
                        <span>{T`none set — the source's full extent`}</span>
                      )}
                    </div>
                    {entry.status === "update_available" && <p className="dim">{T`Your area of interest, schedule, limits, and settings are preserved.`}</p>}
                    <label>
                      <input type="checkbox" disabled={busy} checked={runNow} onChange={e => setRunNow(e.target.checked)} />{" "}
                      {T`Run ingestion now`}
                    </label>
                    <div className="aoi-actions">
                      <button disabled={busy} onClick={() => install(entry)}>
                        {busy ? (entry.status === "update_available" ? T`Updating…` : T`Installing…`) : entry.status === "not_installed" ? T`Install` : T`Update`}
                      </button>
                      <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>
                        {T`Cancel`}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
        </div>
        )}
        </>
      )}
      <SkillsSection />
    </main>
  )
}

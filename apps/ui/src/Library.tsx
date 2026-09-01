import { useEffect, useState } from "react"
import {
  DefaultAoi,
  getSettings,
  getSkill,
  installLibraryEntry,
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
      <h2>{T`Skills`}</h2>
      <p className="dim">
        {T`Source and technique notes the designer agent reads while building an integration: publishing quirks, file layouts, working snippets. Reference material, nothing to install.`}
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

/**
 * Human label for the entry's relationship to this deployment. Built per call
 * rather than once at module load, so a locale change reaches them.
 */
function statusLabels(): Record<LibraryEntry["status"], string> {
  return {
    not_installed: T`not installed`,
    installed: T`installed`,
    update_available: T`update available`
  }
}

/**
 * The integration library: every entry the deployment's library ships,
 * installable in one confirmation. Installing copies the entry's values into
 * the integration's definition; updating keeps the deployment-owned fields
 * (area of interest, schedule, limits).
 */
export function Library({ user }: { user: User }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [defaultAoi, setDefaultAoi] = useState<DefaultAoi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [runNow, setRunNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState<{ id: string; version: number; ran: boolean } | null>(null)

  const canDesign = user.role !== "viewer"

  function refresh() {
    listLibrary().then(r => setEntries(r.entries), err => setError(err.message))
  }

  useEffect(() => {
    refresh()
    getSettings().then(r => setDefaultAoi(r.settings.default_aoi), () => {})
  }, [])

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
    <main className="list-page">
      <h1>{T`Library`}</h1>
      <p className="dim">
        {T`Ready-made integrations shipped with this deployment. Installing copies the entry's settings into your integration; updates keep your area of interest, schedule, and limits.`}
      </p>
      {error && <div className="error">{error}</div>}
      {installed && (
        <p>
          {installed.ran
            ? T`Installed ${<a href={`#/integration/${installed.id}`}>{installed.id}</a>} (v${installed.version}); first ingest started.`
            : T`Installed ${<a href={`#/integration/${installed.id}`}>{installed.id}</a>} (v${installed.version}).`}
        </p>
      )}
      {entries === null ? (
        <p>{T`Loading…`}</p>
      ) : entries.length === 0 ? (
        <p>{T`This deployment has no library configured.`}</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>{T`Integration`}</th><th>{T`Cadence`}</th><th>{T`Destinations`}</th><th>{T`Status`}</th>{canDesign && <th />}</tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <>
                <tr key={entry.id}>
                  <td>
                    <b>{localizeData(entry.name)}</b>
                    {entry.description && <div className="dim">{localizeData(entry.description)}</div>}
                    {entry.source && (
                      <div className="dim">
                        {[entry.source.provider ?? localizeData(entry.source.name), entry.source.license]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td>{triggerLabel(entry.trigger)}</td>
                  <td>
                    {entry.destinations.map(d => (
                      <span key={`${d.kind}:${d.id}`} className="chip" style={{ marginRight: 4 }}>
                        {d.id}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`chip ${entry.status === "installed" ? "chip-finished" : entry.status === "update_available" ? "chip-paused" : ""}`}>
                      {statusLabels()[entry.status]}
                      {entry.installedVersion !== null ? ` (v${entry.installedVersion})` : ""}
                    </span>
                  </td>
                  {canDesign && (
                    <td>
                      {entry.status !== "installed" && (
                        <button onClick={() => { setConfirming(confirming === entry.id ? null : entry.id); setInstalled(null) }}>
                          {entry.status === "not_installed" ? T`Install` : T`Update`}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {confirming === entry.id && (
                  <tr key={`${entry.id}-confirm`} className="library-confirm">
                    <td colSpan={canDesign ? 5 : 4}>
                      <div className="library-confirm-body">
                        <div>
                          <b>{T`Schedule:`}</b> {triggerLabel(entry.trigger)}
                          {entry.trigger.cron ? <span className="dim"> {T`(cron ${entry.trigger.cron})`}</span> : null}
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
                        <label>
                          <input type="checkbox" checked={runNow} onChange={e => setRunNow(e.target.checked)} />{" "}
                          {T`Run first ingest now`}
                        </label>
                        <div className="aoi-actions">
                          <button disabled={busy} onClick={() => install(entry)}>
                            {busy ? T`Installing…` : entry.status === "not_installed" ? T`Install` : T`Update`}
                          </button>
                          <button className="secondary" onClick={() => setConfirming(null)}>
                            {T`Cancel`}
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
      <SkillsSection />
    </main>
  )
}

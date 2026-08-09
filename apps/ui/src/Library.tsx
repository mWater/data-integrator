import { useEffect, useState } from "react"
import { DefaultAoi, getSettings, installLibraryEntry, LibraryEntry, listLibrary, User } from "./api.js"
import { triggerLabel } from "./IntegrationList.js"

/** Human label for the entry's relationship to this deployment. */
const STATUS_LABEL: Record<LibraryEntry["status"], string> = {
  not_installed: "not installed",
  installed: "installed",
  update_available: "update available"
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
      <h1>Library</h1>
      <p className="dim">
        Ready-made integrations shipped with this deployment. Installing copies the entry's
        settings into your integration; updates keep your area of interest, schedule, and limits.
      </p>
      {error && <div className="error">{error}</div>}
      {installed && (
        <p>
          Installed <a href={`#/integration/${installed.id}`}>{installed.id}</a> (v{installed.version})
          {installed.ran ? "; first ingest started." : "."}
        </p>
      )}
      {entries === null ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>This deployment has no library configured.</p>
      ) : (
        <table className="sessions">
          <thead>
            <tr><th>Integration</th><th>Cadence</th><th>Destinations</th><th>Status</th>{canDesign && <th />}</tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <>
                <tr key={entry.id}>
                  <td>
                    <b>{entry.name}</b>
                    {entry.description && <div className="dim">{entry.description}</div>}
                    {entry.source && (
                      <div className="dim">
                        {[entry.source.provider ?? entry.source.name, entry.source.license]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td>{triggerLabel(entry.trigger)}</td>
                  <td>
                    {entry.destinations.map(d => (
                      <span key={`${d.kind}:${d.id}`} className={`chip chip-${d.kind}`} style={{ marginRight: 4 }}>
                        {d.id}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`chip ${entry.status === "installed" ? "chip-finished" : entry.status === "update_available" ? "chip-paused" : ""}`}>
                      {STATUS_LABEL[entry.status]}
                      {entry.installedVersion !== null ? ` (v${entry.installedVersion})` : ""}
                    </span>
                  </td>
                  {canDesign && (
                    <td>
                      {entry.status !== "installed" && (
                        <button onClick={() => { setConfirming(confirming === entry.id ? null : entry.id); setInstalled(null) }}>
                          {entry.status === "not_installed" ? "Install" : "Update"}
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
                          <b>Schedule:</b> {triggerLabel(entry.trigger)}
                          {entry.trigger.cron ? <span className="dim"> (cron {entry.trigger.cron})</span> : null}
                        </div>
                        <div>
                          <b>Area of interest:</b>{" "}
                          {entry.status === "update_available" ? (
                            <span>unchanged — keeps the installed integration's area</span>
                          ) : defaultAoi ? (
                            <span>
                              deployment default — {defaultAoi.name ?? "custom"} [{defaultAoi.bbox.map(v => v.toFixed(2)).join(", ")}]
                            </span>
                          ) : (
                            <span>none set — the source's full extent</span>
                          )}
                        </div>
                        <label>
                          <input type="checkbox" checked={runNow} onChange={e => setRunNow(e.target.checked)} /> Run
                          first ingest now
                        </label>
                        <div className="aoi-actions">
                          <button disabled={busy} onClick={() => install(entry)}>
                            {busy ? "Installing…" : entry.status === "not_installed" ? "Install" : "Update"}
                          </button>
                          <button className="linkish" onClick={() => setConfirming(null)}>
                            Cancel
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
    </main>
  )
}

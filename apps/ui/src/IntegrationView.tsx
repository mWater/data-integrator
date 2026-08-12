import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CountryBox,
  createSession,
  DefaultAoi,
  deleteIntegration,
  getIntegration,
  getIntegrationUsage,
  getIntegrationVersions,
  getSettings,
  IntegrationDetail,
  IntegrationUsage,
  listCountries,
  setIntegrationAoi,
  setIntegrationEnabled,
  setIntegrationTrigger,
  startRun,
  VersionSummary
} from "./api.js"
import { ConfirmDelete } from "./ConfirmDelete.js"
import { triggerLabel } from "./IntegrationList.js"
import { DataTab } from "./TablePage.js"

/** Props for the integration detail view. */
interface IntegrationViewProps {
  /** Integration to display */
  integrationId: string
  /** False for viewers: hides Design with Agent and Run Now */
  canDesign: boolean
}

/** Detail tabs. */
type Tab = "runs" | "data" | "definition" | "code"

/** Poll cadence while a run is in flight. */
const POLL_MS = 2500

/** One installed integration: data, run history, definition, code. */
export function IntegrationView({ integrationId, canDesign }: IntegrationViewProps) {
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [picked, setPicked] = useState<Tab | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<IntegrationUsage | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    getIntegration(integrationId).then(setDetail, err => setError(err.message))
  }, [integrationId])

  useEffect(() => {
    refresh()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [refresh])

  const running = detail?.runs.some(run => run.status === "queued" || run.status === "running") ?? false

  // Poll while a run is in flight so the table refreshes itself
  useEffect(() => {
    if (running && !pollTimer.current) {
      pollTimer.current = setInterval(refresh, POLL_MS)
    } else if (!running && pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [running, refresh])

  async function onRun() {
    setError(null)
    try {
      await startRun(integrationId)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onDesign() {
    setError(null)
    try {
      const { sessionId } = await createSession(integrationId)
      window.location.hash = `#/session/${sessionId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onToggleEnabled() {
    setError(null)
    try {
      await setIntegrationEnabled(integrationId, !detail!.enabled)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Opens the delete dialog once usage (dependents, dashboards) is known. */
  async function onDeleteOpen() {
    setError(null)
    try {
      setUsage(await getIntegrationUsage(integrationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onDeleteConfirm() {
    setError(null)
    try {
      await deleteIntegration(integrationId)
      window.location.hash = "#/integrations"
    } catch (err) {
      setUsage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!detail) return <main className="list-page">{error ? <div className="error">{error}</div> : "Loading…"}</main>

  const { definition } = detail
  const tableIds = detail.destinations.filter(d => d.kind === "table").map(d => d.id)
  // Data leads when there is data to show; raster-only integrations lead with runs
  const tab = picked ?? (tableIds.length > 0 ? "data" : "runs")
  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{definition.name}</h1>
        {detail.status === "draft" && <span className="chip chip-draft">draft</span>}
        <span className="chip">{triggerLabel(definition.trigger as { cron?: string })}</span>
        {!detail.enabled && <span className="chip chip-paused">paused</span>}
        <span style={{ flex: 1 }} />
        {canDesign && (
          <button className="secondary" onClick={onToggleEnabled} title="Paused integrations are skipped by the scheduler">
            {detail.enabled ? "Pause" : "Resume"}
          </button>
        )}
        {canDesign && (
          <button className="secondary" onClick={onRun} disabled={running}>
            {running ? "Running…" : "Run Now"}
          </button>
        )}
        {canDesign && <button onClick={onDesign}>Design with Agent</button>}
        {canDesign && (
          <button className="danger" onClick={() => void onDeleteOpen()}>
            Delete
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {usage && (
        <DeleteIntegrationDialog
          detail={detail}
          usage={usage}
          onCancel={() => setUsage(null)}
          onConfirm={() => void onDeleteConfirm()}
        />
      )}

      <div className="dest-cards">
        {detail.destinations.map(d => (
          <div key={d.id} className="dest-card">
            <div className="dim">{d.kind === "table" ? "table" : "raster layer"}</div>
            <b>{d.id}</b>
            <div>
              {d.count === null
                ? running
                  ? "first run in progress…"
                  : canDesign
                    ? "no data yet — Run Now loads it"
                    : "no data yet"
                : `${d.count.toLocaleString()} ${d.kind === "table" ? "rows" : "snapshots"}`}
            </div>
            {d.kind === "raster" && d.count !== null && <a href={`#/layer/${d.id}`}>View on map</a>}
          </div>
        ))}
      </div>

      <div className="tabs">
        {([...(tableIds.length ? ["data" as const] : []), "runs", "definition", "code"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setPicked(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "runs" &&
        (detail.runs.length === 0 ? (
          <p>No runs yet.</p>
        ) : (
          <table className="sessions">
            <thead>
              <tr><th>When</th><th>Trigger</th><th>Status</th><th>Result</th></tr>
            </thead>
            <tbody>
              {detail.runs.map(run => (
                <tr key={run.id}>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "queued"}</td>
                  <td>{run.trigger}</td>
                  <td><span className={`chip chip-${run.status}`}>{run.status}</span></td>
                  <td className="dim">
                    {run.error
                      ? run.error.slice(0, 120)
                      : run.stats
                        ? `${Object.entries(run.stats.rows ?? {}).map(([t, n]) => `${t}: ${n}`).join(", ") || `${run.stats.snapshots ?? 0} snapshots`} in ${((run.stats.durationMs ?? 0) / 1000).toFixed(1)}s`
                        : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === "data" && <DataTab integrationId={integrationId} tableIds={tableIds} running={running} />}
      {tab === "definition" && (
        <>
          <ScheduleSection detail={detail} canDesign={canDesign} onChanged={refresh} />
          <AoiSection detail={detail} canDesign={canDesign} onChanged={refresh} />
          <DefinitionTab definition={definition} />
          <VersionsSection integrationId={integrationId} currentVersion={detail.version} />
        </>
      )}
      {tab === "code" && <pre className="pane pane-block pane-code">{definition.code}</pre>}
    </main>
  )
}

/** Formats a bbox for display. */
function formatBbox(bbox: [number, number, number, number]): string {
  return `[${bbox.map(v => v.toFixed(2)).join(", ")}]`
}

/** Props for the schedule section. */
interface ScheduleSectionProps {
  /** Integration detail (definition carries the trigger) */
  detail: IntegrationDetail
  /** False for viewers: read-only display */
  canDesign: boolean
  /** Refetches the detail after a change */
  onChanged: () => void
}

/**
 * The integration's schedule. Trigger is definition content: saving archives
 * a new attributed version. Pausing is separate (the Pause button) and not a
 * definition change.
 */
function ScheduleSection({ detail, canDesign, onChanged }: ScheduleSectionProps) {
  const trigger = (detail.definition.trigger ?? {}) as { cron?: string; webhook?: boolean }
  const [cron, setCron] = useState(trigger.cron ?? "")
  const [webhook, setWebhook] = useState(trigger.webhook === true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function save() {
    setError(null)
    setNotice(null)
    try {
      const result = await setIntegrationTrigger(detail.id, { cron: cron.trim() === "" ? null : cron.trim(), webhook })
      setNotice(
        result.version === detail.version ? "No change." : `Saved as version ${result.version}.`
      )
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aoi-section">
      <h3>Schedule</h3>
      <p>
        Current: <b>{triggerLabel(trigger)}</b>
        {trigger.cron && <span className="dim"> (cron {trigger.cron})</span>}
      </p>
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <div className="aoi-editor">
          <div className="aoi-bbox">
            <label>
              cron (UTC; empty for manual only)
              <input
                type="text"
                style={{ width: 220 }}
                placeholder="0 6 5 * *"
                value={cron}
                onChange={e => setCron(e.target.value)}
              />
            </label>
          </div>
          <label>
            <input type="checkbox" checked={webhook} onChange={e => setWebhook(e.target.checked)} /> Accept webhook
            events
          </label>
          <div className="aoi-actions">
            <button onClick={save}>Save</button>
            <span className="dim">Saving archives a new definition version. Pause instead to stop runs temporarily.</span>
          </div>
          {notice && <p className="dim">{notice}</p>}
        </div>
      )}
    </div>
  )
}

/** Editor choices for the AOI section. */
type AoiChoice = "inherit" | "country" | "custom" | "full"

/** Props for the AOI section. */
interface AoiSectionProps {
  /** Integration detail (definition carries the tri-state aoi) */
  detail: IntegrationDetail
  /** False for viewers: read-only display */
  canDesign: boolean
  /** Refetches the detail after a change */
  onChanged: () => void
}

/**
 * The integration's area of interest. AOI is definition content: saving a
 * change archives a new attributed version, so the history explains why the
 * ingested area changed.
 */
function AoiSection({ detail, canDesign, onChanged }: AoiSectionProps) {
  const aoiPresent = "aoi" in detail.definition
  const aoi = detail.definition.aoi as { bbox: [number, number, number, number]; countries?: string[] } | null

  const [countries, setCountries] = useState<CountryBox[]>([])
  const [defaultAoi, setDefaultAoi] = useState<DefaultAoi | null>(null)
  const [choice, setChoice] = useState<AoiChoice>(!aoiPresent ? "inherit" : aoi === null ? "full" : "custom")
  const [iso3, setIso3] = useState("")
  const [custom, setCustom] = useState({ west: "", south: "", east: "", north: "" })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    listCountries().then(r => setCountries(r.countries), () => {})
    getSettings().then(r => setDefaultAoi(r.settings.default_aoi), () => {})
  }, [])

  const selected = useMemo(() => countries.find(c => c.iso3 === iso3) ?? null, [countries, iso3])
  const countryNames = useMemo(() => {
    const byIso3 = new Map(countries.map(c => [c.iso3, c.name]))
    return (codes: string[] | undefined) => codes?.map(code => byIso3.get(code) ?? code).join(", ")
  }, [countries])

  const current =
    !aoiPresent ? (
      <>
        Deployment default
        {defaultAoi ? (
          <span className="dim"> — {defaultAoi.name ?? "custom"} {formatBbox(defaultAoi.bbox)}</span>
        ) : (
          <span className="dim"> — none set, so the source's full extent</span>
        )}
      </>
    ) : aoi === null ? (
      <>Full source extent</>
    ) : (
      <>
        {countryNames(aoi.countries) ?? "Custom box"} {formatBbox(aoi.bbox)}
      </>
    )

  async function save() {
    setError(null)
    setNotice(null)
    try {
      let body: Parameters<typeof setIntegrationAoi>[1]
      if (choice === "inherit" || choice === "full") body = { mode: choice }
      else if (choice === "country") {
        if (!selected) throw new Error("Pick a country first")
        body = { mode: "box", aoi: { bbox: selected.bbox, countries: [selected.iso3] } }
      } else {
        const values = [custom.west, custom.south, custom.east, custom.north].map(Number)
        if (values.some(v => !Number.isFinite(v)) || [custom.west, custom.south, custom.east, custom.north].some(v => v === "")) {
          throw new Error("All four bbox values are required")
        }
        body = { mode: "box", aoi: { bbox: values as [number, number, number, number] } }
      }
      const { version } = await setIntegrationAoi(detail.id, body)
      setNotice(version === detail.version ? "No change." : `Saved as version ${version}; future runs use it.`)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aoi-section">
      <h3>Area of interest</h3>
      <p>
        Current: <b>{current}</b>
      </p>
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <div className="aoi-editor">
          <div className="aoi-mode">
            {(
              [
                ["inherit", "Deployment default"],
                ["country", "Country"],
                ["custom", "Custom bounding box"],
                ["full", "Full source extent"]
              ] as [AoiChoice, string][]
            ).map(([value, label]) => (
              <label key={value}>
                <input type="radio" checked={choice === value} onChange={() => setChoice(value)} /> {label}
              </label>
            ))}
          </div>
          {choice === "country" && (
            <select value={iso3} onChange={e => setIso3(e.target.value)}>
              <option value="">Pick a country…</option>
              {countries.map(c => (
                <option key={c.iso3} value={c.iso3}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {choice === "custom" && (
            <div className="aoi-bbox">
              {(["west", "south", "east", "north"] as const).map(edge => (
                <label key={edge}>
                  {edge}
                  <input
                    type="number"
                    step="any"
                    value={custom[edge]}
                    onChange={e => setCustom({ ...custom, [edge]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="aoi-actions">
            <button onClick={save}>Save</button>
            <span className="dim">Saving archives a new definition version. Existing data is unaffected; widening the area needs a backfill.</span>
          </div>
          {notice && <p className="dim">{notice}</p>}
        </div>
      )}
    </div>
  )
}

/** Props for the version history section. */
interface VersionsSectionProps {
  /** Integration whose history is shown */
  integrationId: string
  /** Current version; refetches when it advances */
  currentVersion: number
}

/** Definition version history: who changed what, when. */
function VersionsSection({ integrationId, currentVersion }: VersionsSectionProps) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null)

  useEffect(() => {
    getIntegrationVersions(integrationId).then(r => setVersions(r.versions), () => setVersions([]))
  }, [integrationId, currentVersion])

  if (!versions || versions.length === 0) return null
  return (
    <div className="dest-def">
      <h3>
        Versions <span className="dim">definition history, newest first</span>
      </h3>
      <table className="sessions">
        <thead>
          <tr><th>Version</th><th>When</th><th>By</th><th>Area of interest</th></tr>
        </thead>
        <tbody>
          {versions.map(v => (
            <tr key={v.version}>
              <td>
                v{v.version}
                {v.version === currentVersion && <span className="chip chip-certified" style={{ marginLeft: 8 }}>current</span>}
              </td>
              <td>{new Date(v.createdAt).toLocaleString()}</td>
              <td>{v.createdBy ?? <span className="dim">system</span>}</td>
              <td className="dim">
                {v.aoiMode === "inherit"
                  ? "deployment default"
                  : v.aoiMode === "full"
                    ? "full source extent"
                    : `${v.aoi?.countries?.join(", ") ?? "custom"} ${v.aoi ? formatBbox(v.aoi.bbox) : ""}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Column of a table destination as the definition declares it. */
interface ColumnSpec {
  /** Column id (SQL name) */
  id: string
  /** Display name */
  name?: string
  /** Column type */
  type: string
  /** Units of measure */
  units?: string
  /** Values when type is enum */
  enumValues?: { id: string; name?: string }[]
}

/** Table destination fields the definition tab renders. */
interface TableDest {
  /** Destination kind */
  kind: "table"
  /** Table id */
  tableId: string
  /** Load action */
  action: string
  /** Merge key columns */
  mergeColumns?: string[]
  /** Declared columns */
  columns: ColumnSpec[]
}

/** Raster destination fields the definition tab renders. */
interface RasterDest {
  /** Destination kind */
  kind: "raster"
  /** Layer id */
  layerId: string
  /** Display name */
  name?: string
  /** time-series or current-only */
  temporality: string
  /** Declared bands */
  bands: { id: string; name?: string; units?: string }[]
}

/** Props for the definition tab. */
interface DefinitionTabProps {
  /** Installed definition (loosely typed JSON) */
  definition: Record<string, unknown>
}

/** Human-readable definition: description, source, schedule, and per-destination schemas. */
function DefinitionTab({ definition }: DefinitionTabProps) {
  const source = definition.source as { name?: string; url?: string; license?: string } | undefined
  const destinations = (definition.destinations ?? []) as (TableDest | RasterDest)[]
  return (
    <div className="definition-tab">
      {typeof definition.description === "string" && <p>{definition.description}</p>}
      <dl className="facts">
        {source?.name && (
          <>
            <dt>Source</dt>
            <dd>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a>
              ) : (
                source.name
              )}
              {source.license ? ` · ${source.license}` : ""}
            </dd>
          </>
        )}
        <dt>Schedule</dt>
        <dd>{triggerLabel((definition.trigger ?? {}) as { cron?: string })}</dd>
      </dl>
      {destinations.map(dest =>
        dest.kind === "table" ? (
          <div key={dest.tableId} className="dest-def">
            <h3>
              {dest.tableId}{" "}
              <span className="dim">
                table · {dest.action}
                {dest.mergeColumns ? ` on ${dest.mergeColumns.join(", ")}` : ""}
              </span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>Column</th><th>Type</th><th>Units</th></tr>
              </thead>
              <tbody>
                {dest.columns.map(column => (
                  <tr key={column.id}>
                    <td>
                      <b>{column.name ?? column.id}</b>
                      {column.name && column.name !== column.id && <div className="dim">{column.id}</div>}
                    </td>
                    <td>
                      {column.type}
                      {column.type === "enum" && column.enumValues
                        ? `: ${column.enumValues.map(v => v.name ?? v.id).join(", ")}`
                        : ""}
                    </td>
                    <td>{column.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div key={dest.layerId} className="dest-def">
            <h3>
              {dest.name ?? dest.layerId} <span className="dim">raster · {dest.temporality}</span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>Band</th><th>Units</th></tr>
              </thead>
              <tbody>
                {dest.bands.map(band => (
                  <tr key={band.id}>
                    <td>{band.name ?? band.id}</td>
                    <td>{band.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

/** Props for the integration delete dialog. */
interface DeleteIntegrationDialogProps {
  /** Integration being deleted */
  detail: IntegrationDetail
  /** What it owns and who depends on it */
  usage: IntegrationUsage
  /** Dismisses without deleting */
  onCancel: () => void
  /** Proceeds with the delete */
  onConfirm: () => void
}

/**
 * Integration delete confirmation. Deletion takes the integration's data with
 * it, so the dialog enumerates every table and layer that dies; dependent
 * integrations block deletion outright.
 */
function DeleteIntegrationDialog({ detail, usage, onCancel, onConfirm }: DeleteIntegrationDialogProps) {
  const blocked = usage.dependents.length > 0
  if (blocked) {
    return (
      <>
        <div className="drawer-backdrop" onClick={onCancel} />
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="Cannot delete">
          <h2>“{detail.definition.name}” cannot be deleted yet</h2>
          <p>Other integrations read its data and would break:</p>
          <ul>
            {usage.dependents.map(d => (
              <li key={`${d.id}-${d.via}`}>
                <b>{d.id}</b> reads <code>{d.via}</code>
              </li>
            ))}
          </ul>
          <p className="dim">Delete or edit those integrations first.</p>
          <div className="confirm-actions">
            <button className="secondary" onClick={onCancel}>Close</button>
          </div>
        </div>
      </>
    )
  }
  const tables = detail.destinations.filter(d => d.kind === "table")
  const rasters = detail.destinations.filter(d => d.kind === "raster")
  return (
    <ConfirmDelete
      title={`Delete “${detail.definition.name}”?`}
      confirmToken={detail.id}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        Integrations own their data, so deleting this integration <b>permanently deletes the data itself</b>, not just
        the pipeline. <b>This cannot be undone</b>, and data from sources that no longer publish history cannot be
        re-ingested. This will delete:
      </p>
      <ul>
        {tables.map(t => (
          <li key={t.id}>
            table <code>{t.id}</code>{t.count !== null ? ` — ${t.count.toLocaleString()} rows` : ""}
          </li>
        ))}
        {rasters.map(r => (
          <li key={r.id}>
            raster layer <code>{r.id}</code>{r.count !== null ? ` — ${r.count.toLocaleString()} snapshots (files included)` : ""}
          </li>
        ))}
        <li>{usage.runs.toLocaleString()} run{usage.runs === 1 ? "" : "s"} of history and any pending webhook events</li>
      </ul>
      {usage.dashboards.length > 0 && (
        <p>
          ⚠ {usage.dashboards.length === 1 ? "A dashboard appears" : `${usage.dashboards.length} dashboards appear`} to
          query this data and will break: {usage.dashboards.map(d => d.name).join(", ")}.
        </p>
      )}
      <p className="dim">Design sessions that built it are kept, with their link to this integration cleared.</p>
    </ConfirmDelete>
  )
}

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
  getWebhookToken,
  rotateWebhookToken,
  IntegrationDetail,
  IntegrationUsage,
  listCountries,
  RunSummary,
  setIntegrationAoi,
  setIntegrationEnabled,
  setIntegrationTrigger,
  startRun,
  VersionSummary
} from "./api.js"
import { ConfirmDelete } from "./ConfirmDelete.js"
import { CronEditor, fromCronDraft, toCronDraft } from "./CronEditor.js"
import { SecretsSection } from "./SecretsSection.js"
import { triggerLabel } from "./IntegrationList.js"
import { DataTab } from "./TablePage.js"

/** What a finished run produced, as "sites: 412, readings: 9k in 3.4s". */
function runStatsText(stats: NonNullable<RunSummary["stats"]>): string {
  const rows = Object.entries(stats.rows ?? {})
    .map(([table, count]) => `${table}: ${count}`)
    .join(", ")
  const produced = rows || T`${stats.snapshots ?? 0} snapshots`
  const seconds = ((stats.durationMs ?? 0) / 1000).toFixed(1)
  return T`${produced} in ${seconds}s`
}

/** Props for the integration detail view. */
interface IntegrationViewProps {
  /** Integration to display */
  integrationId: string
  /** False for viewers: hides Design with Agent and Run Now */
  canDesign: boolean
  /** True for admins: enables webhook token rotation */
  isAdmin: boolean
}

/** Detail tabs. */
type Tab = "runs" | "data" | "definition" | "code"

/** Poll cadence while a run is in flight. */
const POLL_MS = 2500

/** One installed integration: data, run history, definition, code. */
export function IntegrationView({ integrationId, canDesign, isAdmin }: IntegrationViewProps) {
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

  if (!detail) return <main className="list-page">{error ? <div className="error">{error}</div> : T`Loading…`}</main>

  const { definition } = detail
  const tableIds = detail.destinations.filter(d => d.kind === "table").map(d => d.id)
  // Data leads when there is data to show; raster-only integrations lead with runs
  const tab = picked ?? (tableIds.length > 0 ? "data" : "runs")
  return (
    <main className="list-page wide">
      <div className="session-head">
        <h1>{definition.name}</h1>
        {detail.status === "draft" && <span className="chip chip-draft">{T`draft`}</span>}
        <span className="chip">{triggerLabel(definition.trigger as { cron?: string })}</span>
        {!detail.enabled && <span className="chip chip-paused">{T`paused`}</span>}
        <span style={{ flex: 1 }} />
        {canDesign && (
          <button className="secondary" onClick={onToggleEnabled} title={T`Paused integrations are skipped by the scheduler`}>
            {detail.enabled ? T`Pause` : T`Resume`}
          </button>
        )}
        {canDesign && (
          <button className="secondary" onClick={onRun} disabled={running}>
            {running ? T`Running…` : T`Run Now`}
          </button>
        )}
        <button
          className="secondary"
          title={T`Download the definition as a file another deployment can import`}
          onClick={() => {
            window.location.href = `/api/integrations/${detail.id}/export`
          }}
        >
          {T`Export`}
        </button>
        {canDesign && <button onClick={onDesign}>{T`Design with Agent`}</button>}
        {canDesign && (
          <button className="danger" onClick={() => void onDeleteOpen()}>
            {T`Delete`}
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
            <div className="dim">{d.kind === "table" ? T`table` : T`raster layer`}</div>
            <b>{d.id}</b>
            <div>
              {d.count === null
                ? running
                  ? T`first run in progress…`
                  : canDesign
                    ? T`no data yet — Run Now loads it`
                    : T`no data yet`
                : d.kind === "table"
                  ? T`${d.count.toLocaleString()} rows`
                  : T`${d.count.toLocaleString()} snapshots`}
            </div>
            {d.kind === "raster" && d.count !== null && <a href={`#/layer/${d.id}`}>{T`View on map`}</a>}
          </div>
        ))}
      </div>

      <div className="tabs">
        {([...(tableIds.length ? ["data" as const] : []), "runs", "definition", "code"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setPicked(t)}>
            {t === "data" ? T`data` : t === "runs" ? T`runs` : t === "definition" ? T`definition` : T`code`}
          </button>
        ))}
      </div>

      {tab === "runs" &&
        (detail.runs.length === 0 ? (
          <p>{T`No runs yet.`}</p>
        ) : (
          <table className="sessions">
            <thead>
              <tr><th>{T`When`}</th><th>{T`Trigger`}</th><th>{T`Status`}</th><th>{T`Result`}</th></tr>
            </thead>
            <tbody>
              {detail.runs.map(run => (
                <tr key={run.id}>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : T`queued`}</td>
                  <td>{run.trigger}</td>
                  <td><span className={`chip chip-${run.status}`}>{run.status}</span></td>
                  <td className="dim">
                    {run.error
                      ? run.error.slice(0, 120)
                      : run.stats
                        ? runStatsText(run.stats)
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
          <ScheduleSection detail={detail} canDesign={canDesign} isAdmin={isAdmin} onChanged={refresh} />
          {canDesign && (
            <SecretsSection
              integrationId={integrationId}
              declared={(definition.secrets as string[] | undefined) ?? []}
              isAdmin={isAdmin}
            />
          )}
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
  /** True for admins: enables webhook token rotation */
  isAdmin: boolean
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
function ScheduleSection({ detail, canDesign, isAdmin, onChanged }: ScheduleSectionProps) {
  const trigger = (detail.definition.trigger ?? {}) as { cron?: string; webhook?: boolean; webhookDelaySeconds?: number }
  const [cronDraft, setCronDraft] = useState(() => toCronDraft(trigger.cron))
  const [webhook, setWebhook] = useState(trigger.webhook === true)
  const [delay, setDelay] = useState(String(trigger.webhookDelaySeconds ?? 0))
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hookPath, setHookPath] = useState<string | null>(null)

  // The capability URL is only fetched when the integration accepts webhooks
  useEffect(() => {
    if (trigger.webhook === true && canDesign) {
      getWebhookToken(detail.id).then(r => setHookPath(r.path), () => setHookPath(null))
    } else setHookPath(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, trigger.webhook, canDesign])

  async function rotate() {
    setError(null)
    try {
      const r = await rotateWebhookToken(detail.id)
      setHookPath(r.path)
      setNotice(T`Webhook URL regenerated; the old URL no longer works.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function save() {
    setError(null)
    setNotice(null)
    try {
      const delaySeconds = webhook ? Number(delay) || 0 : 0
      const result = await setIntegrationTrigger(detail.id, {
        cron: fromCronDraft(cronDraft),
        webhook,
        webhookDelaySeconds: delaySeconds
      })
      setNotice(
        result.version === detail.version ? T`No change.` : T`Saved as version ${result.version}.`
      )
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aoi-section">
      <h3>{T`Schedule`}</h3>
      {!canDesign && (
        <p>
          {T`Current:`} <b>{triggerLabel(trigger)}</b>
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <div className="aoi-editor">
          <CronEditor draft={cronDraft} onChange={setCronDraft} />
          <label>
            <input type="checkbox" checked={webhook} onChange={e => setWebhook(e.target.checked)} /> {T`Accept webhook events`}
          </label>
          {webhook && (
            <label>
              {T`Batch window in seconds (0 runs immediately; events arriving inside the window share one run)`}
              <input type="number" min={0} max={86400} style={{ width: 100 }} value={delay} onChange={e => setDelay(e.target.value)} />
            </label>
          )}
          {hookPath && (
            <p className="dim">
              {T`Webhook URL:`} <code>{`${location.origin}${hookPath}`}</code>{" "}
              <button onClick={() => navigator.clipboard.writeText(`${location.origin}${hookPath}`)}>{T`Copy`}</button>{" "}
              {isAdmin && <button onClick={rotate}>{T`Regenerate`}</button>}
            </p>
          )}
          <div className="aoi-actions">
            <button onClick={save}>{T`Save`}</button>
            <span className="dim">{T`Saving archives a new definition version. Pause instead to stop runs temporarily.`}</span>
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
        {T`Deployment default`}
        {defaultAoi ? (
          <span className="dim"> — {defaultAoi.name ?? T`custom`} {formatBbox(defaultAoi.bbox)}</span>
        ) : (
          <span className="dim"> — {T`none set, so the source's full extent`}</span>
        )}
      </>
    ) : aoi === null ? (
      <>{T`Full source extent`}</>
    ) : (
      <>
        {countryNames(aoi.countries) ?? T`Custom box`} {formatBbox(aoi.bbox)}
      </>
    )

  async function save() {
    setError(null)
    setNotice(null)
    try {
      let body: Parameters<typeof setIntegrationAoi>[1]
      if (choice === "inherit" || choice === "full") body = { mode: choice }
      else if (choice === "country") {
        if (!selected) throw new Error(T`Pick a country first`)
        body = { mode: "box", aoi: { bbox: selected.bbox, countries: [selected.iso3] } }
      } else {
        const values = [custom.west, custom.south, custom.east, custom.north].map(Number)
        if (values.some(v => !Number.isFinite(v)) || [custom.west, custom.south, custom.east, custom.north].some(v => v === "")) {
          throw new Error(T`All four bbox values are required`)
        }
        body = { mode: "box", aoi: { bbox: values as [number, number, number, number] } }
      }
      const { version } = await setIntegrationAoi(detail.id, body)
      setNotice(version === detail.version ? T`No change.` : T`Saved as version ${version}; future runs use it.`)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aoi-section">
      <h3>{T`Area of interest`}</h3>
      <p>
        {T`Current:`} <b>{current}</b>
      </p>
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <div className="aoi-editor">
          <div className="aoi-mode">
            {(
              [
                ["inherit", T`Deployment default`],
                ["country", T`Country`],
                ["custom", T`Custom bounding box`],
                ["full", T`Full source extent`]
              ] as [AoiChoice, string][]
            ).map(([value, label]) => (
              <label key={value}>
                <input type="radio" checked={choice === value} onChange={() => setChoice(value)} /> {label}
              </label>
            ))}
          </div>
          {choice === "country" && (
            <select value={iso3} onChange={e => setIso3(e.target.value)}>
              <option value="">{T`Pick a country…`}</option>
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
                  {edge === "west" ? T`west` : edge === "south" ? T`south` : edge === "east" ? T`east` : T`north`}
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
            <button onClick={save}>{T`Save`}</button>
            <span className="dim">{T`Saving archives a new definition version. Existing data is unaffected; widening the area needs a backfill.`}</span>
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
        {T`Versions`} <span className="dim">{T`definition history, newest first`}</span>
      </h3>
      <table className="sessions">
        <thead>
          <tr><th>{T`Version`}</th><th>{T`When`}</th><th>{T`By`}</th><th>{T`Area of interest`}</th></tr>
        </thead>
        <tbody>
          {versions.map(v => (
            <tr key={v.version}>
              <td>
                {T`v${v.version}`}
                {v.version === currentVersion && <span className="chip chip-certified" style={{ marginLeft: 8 }}>{T`current`}</span>}
              </td>
              <td>{new Date(v.createdAt).toLocaleString()}</td>
              <td>{v.createdBy ?? <span className="dim">{T`system`}</span>}</td>
              <td className="dim">
                {v.aoiMode === "inherit"
                  ? T`deployment default`
                  : v.aoiMode === "full"
                    ? T`full source extent`
                    : `${v.aoi?.countries?.join(", ") ?? T`custom`} ${v.aoi ? formatBbox(v.aoi.bbox) : ""}`}
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
            <dt>{T`Source`}</dt>
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
        <dt>{T`Schedule`}</dt>
        <dd>{triggerLabel((definition.trigger ?? {}) as { cron?: string })}</dd>
      </dl>
      {destinations.map(dest =>
        dest.kind === "table" ? (
          <div key={dest.tableId} className="dest-def">
            <h3>
              {dest.tableId}{" "}
              <span className="dim">
                {dest.mergeColumns
                  ? T`table · ${dest.action} on ${dest.mergeColumns.join(", ")}`
                  : T`table · ${dest.action}`}
              </span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>{T`Column`}</th><th>{T`Type`}</th><th>{T`Units`}</th></tr>
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
              {dest.name ?? dest.layerId} <span className="dim">{T`raster · ${dest.temporality}`}</span>
            </h3>
            <table className="sessions">
              <thead>
                <tr><th>{T`Band`}</th><th>{T`Units`}</th></tr>
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
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`Cannot delete`}>
          <h2>{T`“${detail.definition.name}” cannot be deleted yet`}</h2>
          <p>{T`Other integrations read its data and would break:`}</p>
          <ul>
            {usage.dependents.map(d => (
              <li key={`${d.id}-${d.via}`}>
                <b>{d.id}</b> {T`reads`} <code>{d.via}</code>
              </li>
            ))}
          </ul>
          <p className="dim">{T`Delete or edit those integrations first.`}</p>
          <div className="confirm-actions">
            <button className="secondary" onClick={onCancel}>{T`Close`}</button>
          </div>
        </div>
      </>
    )
  }
  const tables = detail.destinations.filter(d => d.kind === "table")
  const rasters = detail.destinations.filter(d => d.kind === "raster")
  return (
    <ConfirmDelete
      title={T`Delete “${detail.definition.name}”?`}
      confirmToken={detail.id}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        <b>
          {T`Integrations own their data, so deleting this integration permanently deletes the data itself, not just the pipeline.`}
        </b>{" "}
        {T`This cannot be undone, and data from sources that no longer publish history cannot be re-ingested.`}{" "}
        {T`This will delete:`}
      </p>
      <ul>
        {tables.map(t => (
          <li key={t.id}>
            {T`table`} <code>{t.id}</code>{t.count !== null ? ` — ${T`${t.count.toLocaleString()} rows`}` : ""}
          </li>
        ))}
        {rasters.map(r => (
          <li key={r.id}>
            {T`raster layer`} <code>{r.id}</code>{r.count !== null ? ` — ${T`${r.count.toLocaleString()} snapshots (files included)`}` : ""}
          </li>
        ))}
        <li>
          {usage.runs === 1
            ? T`${usage.runs.toLocaleString()} run of history and any pending webhook events`
            : T`${usage.runs.toLocaleString()} runs of history and any pending webhook events`}
        </li>
      </ul>
      {usage.dashboards.length > 0 && (
        <p>
          ⚠{" "}
          {usage.dashboards.length === 1
            ? T`A dashboard appears to query this data and will break: ${usage.dashboards.map(d => d.name).join(", ")}.`
            : T`${usage.dashboards.length} dashboards appear to query this data and will break: ${usage.dashboards.map(d => d.name).join(", ")}.`}
        </p>
      )}
      <p className="dim">{T`Design sessions that built it are kept, with their link to this integration cleared.`}</p>
    </ConfirmDelete>
  )
}

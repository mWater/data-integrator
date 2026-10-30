import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CountryBox,
  createSession,
  DefaultAoi,
  deleteIntegration,
  FileSlotSpec,
  getIntegration,
  getIntegrationUsage,
  getIntegrationVersions,
  getSettings,
  getWebhookToken,
  rotateWebhookToken,
  IntegrationDetail,
  IntegrationUsage,
  listCountries,
  renameIntegration,
  RunSummary,
  setIntegrationAoi,
  setIntegrationEnabled,
  setIntegrationTrigger,
  startRun,
  VersionSummary
} from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { ConfirmDelete } from "./ConfirmDelete.js"
import { CronEditor, fromCronDraft, toCronDraft } from "./CronEditor.js"
import { RowMenu } from "./RowMenu.js"
import { SecretsSection } from "./SecretsSection.js"
import { FilesSection } from "./FilesSection.js"
import { RebuildDialog, SettingsSection } from "./IntegrationSettings.js"
import { triggerLabel } from "./IntegrationList.js"
import { DataTab } from "./TablePage.js"
import { formatDateTime, localizeData } from "./localization.js"
import type { LocalizedString } from "ez-localize"

/** Run triggers in the interface language. */
function triggerLabels(): Record<string, string> {
  return { cron: T`schedule`, webhook: T`webhook`, manual: T`manual`, rebuild: T`rebuild`, agent: T`design session` }
}

/** Run statuses in the interface language. */
function runStatusLabels(): Record<string, string> {
  return { queued: T`queued`, running: T`running`, succeeded: T`succeeded`, failed: T`failed`, timeout: T`timed out` }
}

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
  const [renaming, setRenaming] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    getIntegration(integrationId).then(
      detail => {
        setDetail(detail)
        setError(null)
      },
      err => setError(err.message)
    )
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
    if (!(await ensureAiAck())) return
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
  const trigger = (definition.trigger ?? {}) as { cron?: string; webhook?: boolean }
  // A webhook-only integration has nothing to fetch: its data arrives in deliveries
  const canRebuild = canDesign && detail.status !== "draft" && !(trigger.webhook && !trigger.cron)
  const tableIds = detail.destinations.filter(d => d.kind === "table").map(d => d.id)
  // Data leads when there is data to show; raster-only integrations lead with runs
  const tab = picked ?? (tableIds.length > 0 ? "data" : "runs")
  return (
    <main className="list-page integration-page">
      <a className="integration-back" href="#/integrations">← {T`Integrations`}</a>
      <div className="list-head">
        <div className="list-head-title">
          <h1>{localizeData(definition.name)}</h1>
          <div className="list-head-meta">
            {detail.status === "draft" && <span className="chip chip-draft">{T`draft`}</span>}
            <span className="chip">{triggerLabel(definition.trigger as { cron?: string })}</span>
            {!detail.enabled && <span className="chip chip-paused">{T`paused`}</span>}
            <span className="dim">{detail.id}</span>
          </div>
        </div>
        <div className="list-head-actions">
          {canDesign ? (
            <button
              onClick={onRun}
              disabled={running || detail.status === "draft"}
              title={detail.status === "draft" ? T`Finish the design session before running` : undefined}
            >
              {running ? T`Running…` : T`Run Now`}
            </button>
          ) : null}
          <RowMenu label={T`Actions for ${localizeData(definition.name)}`}>
            {canDesign ? (
              <button role="menuitem" onClick={() => void onDesign()}>
                {T`Design with Agent`}
              </button>
            ) : null}
            {canDesign ? (
              <button role="menuitem" onClick={() => setRenaming(true)}>
                {T`Rename`}
              </button>
            ) : null}
            {canRebuild ? (
              <button
                role="menuitem"
                disabled={running}
                title={T`Run again from nothing: forget earlier progress and fetch everything in scope`}
                onClick={() => setRebuilding(true)}
              >
                {T`Rebuild from Source`}
              </button>
            ) : null}
            {canDesign ? (
              <button
                role="menuitem"
                title={T`Paused integrations are skipped by the scheduler`}
                onClick={() => void onToggleEnabled()}
              >
                {detail.enabled ? T`Pause` : T`Resume`}
              </button>
            ) : null}
            <button
              role="menuitem"
              title={T`Download the definition as a file another deployment can import`}
              onClick={() => {
                window.location.href = `/api/integrations/${detail.id}/export`
              }}
            >
              {T`Export`}
            </button>
            {canDesign ? (
              <button role="menuitem" className="row-menu-danger" onClick={() => void onDeleteOpen()}>
                {T`Delete`}
              </button>
            ) : null}
          </RowMenu>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {renaming && (
        <RenameIntegrationDialog
          id={detail.id}
          current={localizeData(definition.name)}
          onCancel={() => setRenaming(false)}
          onRenamed={() => {
            setRenaming(false)
            refresh()
          }}
        />
      )}
      {rebuilding && (
        <RebuildDialog
          detail={detail}
          onCancel={() => setRebuilding(false)}
          onStarted={() => {
            setRebuilding(false)
            setPicked("runs")
            refresh()
          }}
        />
      )}
      {usage && (
        <DeleteIntegrationDialog
          detail={detail}
          usage={usage}
          onCancel={() => setUsage(null)}
          onConfirm={() => void onDeleteConfirm()}
        />
      )}

      {detail.destinations.length > 0 ? (
        <div className="panel dest-panel">
          {detail.destinations.map(d => {
            const href = d.kind === "raster" ? `#/layer/${d.id}` : `#/table/${d.id}`
            const fact =
              d.count === null
                ? running
                  ? T`first run in progress…`
                  : canDesign
                    ? T`no data yet — Run Now loads it`
                    : T`no data yet`
                : d.kind === "table"
                  ? T`${d.count.toLocaleString()} rows`
                  : T`${d.count.toLocaleString()} snapshots`
            return (
              <a className="panel-row" href={href} key={d.id}>
                <span className={`chip chip-${d.kind}`}>{d.kind === "table" ? T`table` : T`raster`}</span>
                <span className="grow">{d.id}</span>
                <span className="panel-fact">{fact}</span>
                {d.kind === "raster" && d.count !== null ? <span className="panel-when">{T`View on map`}</span> : null}
              </a>
            )
          })}
        </div>
      ) : null}

      <FilesSection
        integrationId={integrationId}
        declared={(definition.files ?? {}) as Record<string, FileSlotSpec>}
        canDesign={canDesign}
        isDraft={detail.status === "draft"}
        runsKey={detail.runs.slice(0, 5).map(run => `${run.id}:${run.status}`).join(",")}
        onChanged={refresh}
      />

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
                  <td>{run.startedAt ? formatDateTime(run.startedAt) : T`queued`}</td>
                  <td>{triggerLabels()[run.trigger] ?? run.trigger}</td>
                  <td><span className={`chip chip-${run.status}`}>{runStatusLabels()[run.status] ?? run.status}</span></td>
                  <td className="dim">
                    {run.error
                      ? run.error.slice(0, 120)
                      : run.stats
                        ? runStatsText(run.stats)
                        : ""}
                    {run.flags && (
                      <ul className="run-flags">
                        {run.flags.map(flag => <li key={`${flag.destinationId}.${flag.field}.${flag.rule}`}>{flag.message}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === "data" && (
        <DataTab
          integrationId={integrationId}
          tableIds={tableIds}
          running={running}
          columnSpecs={Object.fromEntries(
            ((definition.destinations ?? []) as (TableDest | RasterDest)[])
              .filter((d): d is TableDest => d.kind === "table")
              .map(d => [d.tableId, d.columns])
          )}
        />
      )}
      {tab === "definition" && (
        <div className="integration-definition">
          <ScheduleSection detail={detail} canDesign={canDesign} isAdmin={isAdmin} onChanged={refresh} />
          {canDesign && (
            <SecretsSection
              integrationId={integrationId}
              declared={(definition.secrets as string[] | undefined) ?? []}
              isAdmin={isAdmin}
            />
          )}
          <AoiSection detail={detail} canDesign={canDesign} onChanged={refresh} />
          <SettingsSection
            detail={detail}
            canDesign={canDesign}
            onChanged={refresh}
            onRebuild={() => canRebuild && setRebuilding(true)}
          />
          <DefinitionTab definition={definition} />
          <details className="definition-history"><summary>{T`Version History`}</summary><VersionsSection integrationId={integrationId} currentVersion={detail.version} /></details>
        </div>
      )}
      {tab === "code" && <pre className="pane pane-block pane-code">{definition.code}</pre>}
    </main>
  )
}

/** Props for the rename dialog. */
interface RenameIntegrationDialogProps {
  /** Integration being renamed */
  id: string
  /** Current display name in the interface language */
  current: string
  /** Dismisses without renaming */
  onCancel: () => void
  /** Called after the new name is saved */
  onRenamed: () => void
}

/**
 * Display-name edit. The id stays: it is the URL, the library identity and
 * what tables and sessions point at. The name is written in the interface
 * language and translated into the deployment's other languages.
 */
function RenameIntegrationDialog({ id, current, onCancel, onRenamed }: RenameIntegrationDialogProps) {
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await renameIntegration(id, name.trim())
      onRenamed()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`Rename “${current}”`}>
        <h2>{T`Rename “${current}”`}</h2>
        <label>
          <span>{T`Name`}</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={200} />
        </label>
        <p className="dim">
          {T`The id (${id}) and the address stay the same. The new name is translated into the deployment's other languages.`}
        </p>
        {error ? <div className="error">{error}</div> : null}
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            {T`Cancel`}
          </button>
          <button onClick={() => void submit()} disabled={busy || !name.trim() || name.trim() === current}>
            {busy ? T`Saving…` : T`Rename`}
          </button>
        </div>
      </div>
    </>
  )
}

/** Formats a bbox for display. */
function formatBbox(bbox: [number, number, number, number]): string {
  return `[${bbox.map(v => v.toFixed(2)).join(", ")}]`
}

/** Props for the schedule section. */
/** Consistent description and form layout for integration configuration. */
function DefinitionSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="definition-section">
    <div className="definition-section-heading"><h2>{title}</h2><p>{description}</p></div>
    <div className="definition-section-content">{children}</div>
  </section>
}

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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [hookPath, setHookPath] = useState<string | null>(null)

  const dirty = fromCronDraft(cronDraft) !== (trigger.cron ?? null) ||
    webhook !== (trigger.webhook === true) ||
    (webhook && Number(delay) !== (trigger.webhookDelaySeconds ?? 0))

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
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  return (
    <DefinitionSection title={T`Schedule`} description={T`Choose when this integration runs. Pause it from the actions menu to temporarily stop runs.`}>
      {!canDesign && (
        <p>
          {T`Current:`} <b>{triggerLabel(trigger)}</b>
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <fieldset className="aoi-editor" disabled={busy} aria-label={T`Schedule`} onChange={() => setNotice(null)}>
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
            <button onClick={save} disabled={busy || !dirty}>{busy ? T`Saving…` : T`Save Changes`}</button>
            <span className="dim">{T`Changes are saved to version history.`}</span>
          </div>
          {notice && <p className="dim" role="status">{notice}</p>}
        </fieldset>
      )}
    </DefinitionSection>
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
  const [custom, setCustom] = useState({ west: String(aoi?.bbox[0] ?? ""), south: String(aoi?.bbox[1] ?? ""), east: String(aoi?.bbox[2] ?? ""), north: String(aoi?.bbox[3] ?? "") })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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

  const customValues = [custom.west, custom.south, custom.east, custom.north]
  const dirty = choice === "inherit" ? aoiPresent
    : choice === "full" ? !aoiPresent || aoi !== null
    : choice === "country" ? !!selected && !(aoi?.countries?.length === 1 && aoi.countries[0] === iso3 && selected.bbox.every((v, i) => v === aoi.bbox[i]))
    : customValues.every(v => v.trim() && Number.isFinite(Number(v))) &&
      !(aoi && !aoi.countries?.length && customValues.every((v, i) => Number(v) === aoi.bbox[i]))

  async function save() {
    setError(null)
    setNotice(null)
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  return (
    <DefinitionSection title={T`Area of interest`} description={T`Use the deployment default or choose a region for this integration.`}>
      <p className="definition-current">
        {T`Saved area:`} <b>{current}</b>
      </p>
      {error && <div className="error">{error}</div>}
      {canDesign && (
        <fieldset className="aoi-editor" disabled={busy} aria-label={T`Area of interest`} onChange={() => setNotice(null)}>
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
                <input type="radio" name="integration-aoi" checked={choice === value} onChange={() => setChoice(value)} /> {label}
              </label>
            ))}
          </div>
          {choice === "country" && (
            <select aria-label={T`Country`} value={iso3} onChange={e => setIso3(e.target.value)}>
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
            <button onClick={save} disabled={busy || !dirty}>{busy ? T`Saving…` : T`Save Changes`}</button>
            <span className="dim">{T`Applies to future runs. To fill a larger region for periods already loaded, rebuild from source.`}</span>
          </div>
          {notice && <p className="dim" role="status">{notice}</p>}
        </fieldset>
      )}
    </DefinitionSection>
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
              <td>{formatDateTime(v.createdAt)}</td>
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
  name?: LocalizedString
  /** Column type */
  type: string
  /** Units of measure */
  units?: string
  /** Values when type is enum */
  enumValues?: { id: string; name?: LocalizedString }[]
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
  name?: LocalizedString
  /** time-series or current-only */
  temporality: string
  /** Declared bands */
  bands: { id: string; name?: LocalizedString; units?: string }[]
}

/** Props for the definition tab. */
interface DefinitionTabProps {
  /** Installed definition (loosely typed JSON) */
  definition: Record<string, unknown>
}

/** Human-readable definition: description, source, schedule, and per-destination schemas. */
function DefinitionTab({ definition }: DefinitionTabProps) {
  const source = definition.source as { name?: LocalizedString; url?: string; license?: string } | undefined
  const destinations = (definition.destinations ?? []) as (TableDest | RasterDest)[]
  return (
    <DefinitionSection title={T`Source & Outputs`} description={T`Where the data comes from and what this integration produces.`}>
      {definition.description != null && <p>{localizeData(definition.description as LocalizedString | string)}</p>}
      <dl className="facts">
        {source?.name && (
          <>
            <dt>{T`Source`}</dt>
            <dd>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">{localizeData(source.name)}</a>
              ) : (
                localizeData(source.name)
              )}
              {source.license ? ` · ${source.license}` : ""}
            </dd>
          </>
        )}
      </dl>
      {destinations.map(dest =>
        dest.kind === "table" ? (
          <details key={dest.tableId} className="dest-def">
            <summary>
              {dest.tableId}{" "}
              <span className="dim">
                {dest.mergeColumns
                  ? T`table · ${dest.action} on ${dest.mergeColumns.join(", ")}`
                  : T`table · ${dest.action}`}
              </span>
            </summary>
            <table className="sessions">
              <thead>
                <tr><th>{T`Column`}</th><th>{T`Type`}</th><th>{T`Units`}</th></tr>
              </thead>
              <tbody>
                {dest.columns.map(column => (
                  <tr key={column.id}>
                    <td>
                      <b>{column.name ? localizeData(column.name) : column.id}</b>
                      {column.name && localizeData(column.name) !== column.id && <div className="dim">{column.id}</div>}
                    </td>
                    <td>
                      {column.type}
                      {column.type === "enum" && column.enumValues
                        ? `: ${column.enumValues.map(v => (v.name ? localizeData(v.name) : v.id)).join(", ")}`
                        : ""}
                    </td>
                    <td>{column.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : (
          <details key={dest.layerId} className="dest-def">
            <summary>
              {dest.name ? localizeData(dest.name) : dest.layerId}{" "}
              <span className="dim">{T`raster · ${dest.temporality}`}</span>
            </summary>
            <table className="sessions">
              <thead>
                <tr><th>{T`Band`}</th><th>{T`Units`}</th></tr>
              </thead>
              <tbody>
                {dest.bands.map(band => (
                  <tr key={band.id}>
                    <td>{band.name ? localizeData(band.name) : band.id}</td>
                    <td>{band.units ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )
      )}
    </DefinitionSection>
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
          <h2>{T`“${localizeData(detail.definition.name)}” cannot be deleted yet`}</h2>
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
      title={T`Delete “${localizeData(detail.definition.name)}”?`}
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

import { useEffect, useState } from "react"
import { IntegrationDetail, SettingSpec, SettingValue, setIntegrationSettings, startRebuild } from "./api.js"
import { localizeData } from "./localization.js"

/** Props for the settings section. */
interface SettingsSectionProps {
  /** Integration detail; its definition declares the settings and holds the deployment's values */
  detail: IntegrationDetail
  /** False for viewers: read-only display */
  canDesign: boolean
  /** Refetches the detail after a change */
  onChanged: () => void
  /** Opens the rebuild dialog, offered after a change that applies on rebuild */
  onRebuild: () => void
}

/** A form value per setting: text for number and text inputs, a boolean for checkboxes. */
type Draft = Record<string, string | boolean>

/** The settings the definition declares, keyed by id. */
function declaredSettings(detail: IntegrationDetail): Record<string, SettingSpec> {
  return (detail.definition.settings ?? {}) as Record<string, SettingSpec>
}

/** The deployment's value of each setting, or its default. */
function effectiveValues(detail: IntegrationDetail): Record<string, SettingValue> {
  const values = (detail.definition.settingValues ?? {}) as Record<string, SettingValue>
  return Object.fromEntries(
    Object.entries(declaredSettings(detail)).map(([id, spec]) => [id, values[id] ?? spec.default])
  )
}

/** A value as the form holds it. */
function toDraft(spec: SettingSpec, value: SettingValue): string | boolean {
  return spec.type === "boolean" ? value === true : String(value)
}

/** A form value as the setting's type, or undefined when it is not one yet (an empty number field). */
function fromDraft(spec: SettingSpec, draft: string | boolean): SettingValue | undefined {
  if (spec.type === "boolean") return draft === true
  if (spec.type === "integer") {
    const text = String(draft).trim()
    return text !== "" && Number.isInteger(Number(text)) ? Number(text) : undefined
  }
  return String(draft)
}

/** A value for display. */
function displayValue(spec: SettingSpec, value: SettingValue): string {
  if (spec.type === "boolean") return value ? T`Yes` : T`No`
  if (spec.type === "choice") {
    const choice = spec.choices?.find(c => c.value === value)
    return choice ? localizeData(choice.label) : String(value)
  }
  return String(value) === "" ? T`(blank)` : String(value)
}

/**
 * The integration's declared settings. Values are definition content: saving
 * archives a new attributed version, and a value equal to the default is
 * stored as no value, so a later library default applies.
 */
export function SettingsSection({ detail, canDesign, onChanged, onRebuild }: SettingsSectionProps) {
  const specs = declaredSettings(detail)
  const current = effectiveValues(detail)
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, toDraft(spec, current[id])]))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; rebuild: boolean } | null>(null)

  // A new version (this save, or an edit elsewhere) resets the form to what is stored;
  // the notice of the save that made it stays
  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, toDraft(spec, current[id])])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.version])

  const ids = Object.keys(specs)
  if (ids.length === 0) return null

  const parsed = Object.fromEntries(ids.map(id => [id, fromDraft(specs[id], draft[id])]))
  const changed = ids.filter(id => parsed[id] !== current[id])
  const complete = ids.every(id => parsed[id] !== undefined)

  async function save() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const values = Object.fromEntries(
        changed.map(id => [id, parsed[id] === specs[id].default ? null : (parsed[id] as SettingValue)])
      )
      const { version } = await setIntegrationSettings(detail.id, values)
      const rebuild = changed.some(id => specs[id].appliesOn === "rebuild")
      setNotice({
        text: rebuild
          ? T`Saved as version ${version}. Some of these settings take effect when the integration is rebuilt.`
          : T`Saved as version ${version}; future runs use it.`,
        rebuild
      })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="definition-section">
      <div className="definition-section-heading">
        <h2>{T`Settings`}</h2>
        <p>{T`Options this integration offers. Changes are saved as a new version.`}</p>
      </div>
      <div className="definition-section-content">
        {error && <div className="error">{error}</div>}
        {canDesign ? (
          <fieldset className="settings-editor" disabled={busy} aria-label={T`Settings`}>
            {ids.map(id => {
              const spec = specs[id]
              const label = localizeData(spec.label)
              return (
                <div className="setting-field" key={id}>
                  {spec.type === "boolean" ? (
                    <label className="setting-check">
                      <input
                        type="checkbox"
                        checked={draft[id] === true}
                        onChange={e => setDraft({ ...draft, [id]: e.target.checked })}
                      />{" "}
                      {label}
                    </label>
                  ) : (
                    <label>
                      <span>{label}</span>
                      {spec.type === "choice" ? (
                        <select value={String(draft[id])} onChange={e => setDraft({ ...draft, [id]: e.target.value })}>
                          {(spec.choices ?? []).map(choice => (
                            <option key={choice.value} value={choice.value}>
                              {localizeData(choice.label)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={spec.type === "integer" ? "number" : "text"}
                          step={spec.type === "integer" ? 1 : undefined}
                          min={spec.min}
                          max={spec.max}
                          value={String(draft[id])}
                          onChange={e => setDraft({ ...draft, [id]: e.target.value })}
                        />
                      )}
                    </label>
                  )}
                  <p className="dim">
                    {spec.description ? `${localizeData(spec.description)} ` : ""}
                    {T`Default: ${displayValue(spec, spec.default)}.`}
                  </p>
                </div>
              )
            })}
            <div className="aoi-actions">
              <button onClick={() => void save()} disabled={busy || changed.length === 0 || !complete}>
                {busy ? T`Saving…` : T`Save Changes`}
              </button>
            </div>
            {notice && (
              <p className="dim" role="status">
                {notice.text}{" "}
                {notice.rebuild && (
                  <button className="secondary" onClick={onRebuild}>
                    {T`Rebuild from Source`}
                  </button>
                )}
              </p>
            )}
          </fieldset>
        ) : (
          <dl className="layer-facts">
            {ids.map(id => (
              <div key={id}>
                <dt>{localizeData(specs[id].label)}</dt>
                <dd>{displayValue(specs[id], current[id])}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  )
}

/** Props for the rebuild confirmation. */
interface RebuildDialogProps {
  /** Integration to rebuild */
  detail: IntegrationDetail
  /** Dismisses without starting */
  onCancel: () => void
  /** Called once the rebuild has started */
  onStarted: () => void
}

/**
 * Confirms a rebuild: a cold run that forgets earlier runs' progress and the
 * integration's working cache, then produces everything in scope again.
 */
export function RebuildDialog({ detail, onCancel, onStarted }: RebuildDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = localizeData(detail.definition.name)
  const appends = ((detail.definition.destinations ?? []) as { kind: string; action?: string }[]).some(
    d => d.kind === "table" && d.action === "append"
  )

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await startRebuild(detail.id)
      onStarted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`Rebuild “${name}” from source`}>
        <h2>{T`Rebuild “${name}” from source?`}</h2>
        <p>
          {T`A rebuild runs the integration as if for the first time: it forgets what earlier runs recorded and clears its working cache, so everything in its area and history is fetched and produced again.`}
        </p>
        <p>
          {T`Existing data is replaced as the rebuild reproduces it; nothing is deleted first. Large sources can take a long time to download again.`}
        </p>
        {appends && (
          <p>
            <b>{T`This integration appends rows to a table, so a rebuild adds the reproduced rows again.`}</b>
          </p>
        )}
        {error ? <div className="error">{error}</div> : null}
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            {T`Cancel`}
          </button>
          <button onClick={() => void confirm()} disabled={busy}>
            {busy ? T`Starting…` : T`Rebuild`}
          </button>
        </div>
      </div>
    </>
  )
}

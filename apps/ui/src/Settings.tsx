import { LoadState } from "./LoadState.js"
import { FormEvent, useEffect, useMemo, useState } from "react"
import {
  CatalogTranslation,
  setLocalesSetting,
  changePassword,
  clearDefaultAoi,
  CountryBox,
  DefaultAoi,
  getSettings,
  listCountries,
  setDefaultAoi,
  setSiteTitle,
  AiInfo,
  AccountPolicy,
  getAccountPolicy,
  saveAccountPolicy,
  User
} from "./api.js"
import { ThemePreference, useAppTheme } from "./theme.js"
import { formatDateTime, setOfferedLocales } from "./localization.js"
import { UsersSection } from "./UsersSection.js"
import { SettingsRow } from "./SettingsRow.js"
import { AiSettingsSection } from "./AiSettingsSection.js"

/** Shown as the home page title when the deployment has not set one. */
const DEFAULT_SITE_TITLE = "mWater Data Integrator"

/**
 * The deployment's display name, shown as the home page heading. Blank restores
 * the default, so there is no separate clear action.
 */
function SiteTitleSection({ initial, isAdmin }: { initial: string | null; isAdmin: boolean }) {
  const [title, setTitle] = useState(initial ?? "")
  const [saved, setSaved] = useState(initial)
  const [notice, setNotice] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await setSiteTitle(title)
      setSaved(result.site_title)
      setTitle(result.site_title ?? "")
      setNotice(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow id="settings-title" title={T`Deployment name`} description={T`The name shown on the home page.`}>
      {error && <div className="error">{error}</div>}
      {isAdmin ? (
        <form className="title-form" onSubmit={save}>
          <input
            value={title}
            onChange={e => { setTitle(e.target.value); setNotice(false) }}
            placeholder={DEFAULT_SITE_TITLE}
            maxLength={120}
            aria-label={T`Deployment name`}
          />
          <span className="dim">{T`Leave blank to use “${DEFAULT_SITE_TITLE}”.`}</span>
          <div className="settings-actions">
            <button disabled={busy || title.trim() === (saved ?? "")}>{busy ? T`Saving…` : T`Save Changes`}</button>
            {notice && <span className="dim" role="status">{T`Saved.`}</span>}
          </div>
        </form>
      ) : (
        <p className="settings-value">{saved ?? DEFAULT_SITE_TITLE}</p>
      )}
    </SettingsRow>
  )
}

/** Formats a bbox for display. */
function formatBbox(bbox: [number, number, number, number]): string {
  return `[${bbox.map(v => v.toFixed(2)).join(", ")}]`
}

/** Interface theme, applied immediately and remembered on this device. */
function ThemeSection() {
  const { preference, setPreference } = useAppTheme()
  return (
    <SettingsRow id="settings-theme" title={T`Appearance`} description={T`Choose a theme for this device. Changes apply immediately.`}>
      <div className="settings-theme-options" role="group" aria-label={T`Theme`}>
        {([["light", T`Light`], ["dark", T`Dark`], ["system", T`System`]] as [ThemePreference, string][]).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={preference === value} onClick={() => setPreference(value)}>
            {label}
          </button>
        ))}
      </div>
    </SettingsRow>
  )
}

/**
 * Deployment settings. The default area of interest scopes every integration
 * installed without an AOI of its own; admins pick a country from the built-in
 * list or enter a custom bounding box.
 */
export function Settings({ user, ai, onAiChanged }: {
  user: User
  /** The deployment's AI wiring, from /api/me */
  ai: AiInfo
  /** Reloads /api/me after an admin changes the provider */
  onAiChanged: () => void
}) {
  const [current, setCurrent] = useState<DefaultAoi | null>(null)
  const [siteTitle, setSiteTitleState] = useState<string | null>(null)
  const [locales, setLocales] = useState<string[]>([])
  const [supportedLocales, setSupportedLocales] = useState<{ code: string; name: string }[]>([])
  const [translation, setTranslation] = useState<CatalogTranslation | null>(null)
  const [countries, setCountries] = useState<CountryBox[]>([])
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [aoiBusy, setAoiBusy] = useState(false)
  const [aoiError, setAoiError] = useState<string | null>(null)

  // Editor state: a country selection or a custom box
  const [mode, setMode] = useState<"country" | "custom">("country")
  const [iso3, setIso3] = useState("")
  const [custom, setCustom] = useState({ west: "", south: "", east: "", north: "" })

  const isAdmin = user.role === "admin"

  useEffect(() => {
    setError(null)
    Promise.all([getSettings(), listCountries()]).then(
      ([settings, countryList]) => {
        const area = settings.settings.default_aoi
        setCurrent(area)
        if (area) {
          const country = countryList.countries.find(c => area.countries?.length === 1 &&
            c.iso3 === area.countries[0] && c.bbox.every((v, i) => v === area.bbox[i]))
          setMode(country ? "country" : "custom")
          setIso3(country?.iso3 ?? "")
          setCustom({ west: String(area.bbox[0]), south: String(area.bbox[1]), east: String(area.bbox[2]), north: String(area.bbox[3]) })
        }
        setSiteTitleState(settings.settings.site_title)
        setLocales(settings.settings.locales)
        setSupportedLocales(settings.supportedLocales)
        setTranslation(settings.catalogTranslation)
        setCountries(countryList.countries)
        setLoaded(true)
      },
      err => setError(err.message)
    )
  }, [retry])

  const selected = useMemo(() => countries.find(c => c.iso3 === iso3) ?? null, [countries, iso3])

  const customValues = [custom.west, custom.south, custom.east, custom.north]
  const aoiDirty = mode === "country"
    ? !!selected && !(current?.countries?.length === 1 && current.countries[0] === iso3 &&
      selected.bbox.every((v, i) => v === current.bbox[i]))
    : customValues.every(v => v.trim() && Number.isFinite(Number(v))) &&
      !(current && !current.countries?.length && customValues.every((v, i) => Number(v) === current.bbox[i]))

  async function save() {
    setAoiError(null)
    setNotice(null)
    setAoiBusy(true)
    try {
      let aoi: DefaultAoi
      if (mode === "country") {
        if (!selected) throw new Error(T`Pick a country first`)
        aoi = { bbox: selected.bbox, countries: [selected.iso3], name: selected.name }
      } else {
        const values = [custom.west, custom.south, custom.east, custom.north].map(Number)
        if (Object.values(custom).some(v => !v.trim()) || values.some(v => !Number.isFinite(v)))
          throw new Error(T`All four bbox values are required`)
        aoi = { bbox: values as [number, number, number, number] }
      }
      const result = await setDefaultAoi(aoi)
      setCurrent(result.default_aoi)
      setNotice(T`Saved. Future runs of integrations without their own AOI use this area.`)
    } catch (err) {
      setAoiError(err instanceof Error ? err.message : String(err))
    } finally {
      setAoiBusy(false)
    }
  }

  async function clear() {
    setAoiError(null)
    setNotice(null)
    setAoiBusy(true)
    try {
      await clearDefaultAoi()
      setCurrent(null)
      setIso3("")
      setMode("country")
      setCustom({ west: "", south: "", east: "", north: "" })
      setNotice(T`Cleared. Integrations without an AOI ingest their source's full extent.`)
    } catch (err) {
      setAoiError(err instanceof Error ? err.message : String(err))
    } finally {
      setAoiBusy(false)
    }
  }

  return (
    <main className="list-page settings-page">
      <header className="settings-header">
        <h1>{T`Settings`}</h1>
        <p>{T`Manage your deployment and personal preferences.`}</p>
      </header>
      <div className="settings-group-heading">
        <div><h2>{T`Deployment`}</h2><p>{T`Shared settings for everyone using this deployment.`}</p></div>
        {isAdmin && <a className="settings-users-link" href="#/settings/users">{T`Manage Users`} <span aria-hidden="true">→</span></a>}
      </div>
      {!isAdmin && <p className="dim">{T`Only administrators can change deployment settings.`}</p>}
      <div className="settings-group">
        {!loaded ? (
          <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
        ) : (
          <>
            <SiteTitleSection initial={siteTitle} isAdmin={isAdmin} />
            <SettingsRow id="settings-aoi" title={T`Default area of interest`} description={T`Default region for integrations. Individual integrations can override it. Statistics "of the country" use the selected countries' land outline, not the box.`}>
              {aoiError && <div className="error" role="alert">{aoiError}</div>}
              {isAdmin ? (
                <fieldset className="aoi-editor" aria-label={T`Default area of interest`} disabled={aoiBusy} onChange={() => { setNotice(null); setAoiError(null) }}>
                  <div className="aoi-mode">
                    <label>
                      <input
                        type="radio"
                        name="settings-aoi-mode"
                        checked={mode === "country"}
                        onChange={() => setMode("country")}
                      />{" "}
                      {T`Country`}
                    </label>
                    <label>
                      <input type="radio" name="settings-aoi-mode" checked={mode === "custom"} onChange={() => setMode("custom")} />{" "}
                      {T`Custom bounding box`}
                    </label>
                  </div>
                  {mode === "country" ? (
                    <select aria-label={T`Country`} value={iso3} onChange={e => setIso3(e.target.value)}>
                      <option value="">{T`Pick a country…`}</option>
                      {countries.map(c => (
                        <option key={c.iso3} value={c.iso3}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="aoi-bbox">
                      {(
                        [
                          ["west", T`west`],
                          ["south", T`south`],
                          ["east", T`east`],
                          ["north", T`north`]
                        ] as const
                      ).map(([edge, label]) => (
                        <label key={edge}>
                          {label}
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
                    <button onClick={save} disabled={aoiBusy || !aoiDirty}>
                      {aoiBusy ? T`Saving…` : T`Save Changes`}
                    </button>
                    {current && (
                      <button className="secondary" onClick={clear}>
                        {T`Reset to Full Extent`}
                      </button>
                    )}
                  </div>
                  {notice && <p className="dim" role="status">{notice}</p>}
                </fieldset>
              ) : (
                <p className="settings-value">{current?.name ?? current?.countries?.join(", ") ?? (current ? T`Custom bounding box` : T`Full source extent`)}</p>
              )}
              {current ? (
                <details className="settings-details"><summary>{T`Saved area details`}</summary><p>{formatBbox(current.bbox)}</p></details>
              ) : <p className="dim">{T`No default region. Integrations use their source’s full extent.`}</p>}
            </SettingsRow>
          </>
        )}
        {loaded && translation && (
          <LanguagesSection
            isAdmin={isAdmin}
            locales={locales}
            supportedLocales={supportedLocales}
            translation={translation}
            onChange={codes => {
              setLocales(codes)
              // Narrow the navbar picker immediately, not just on next load
              setOfferedLocales(codes)
            }}
          />
        )}
        {isAdmin && <AccountPolicySection />}
        <AiSettingsSection ai={ai} isAdmin={isAdmin} onChanged={onAiChanged} />
      </div>
      <div className="settings-group-heading">
        <div><h2>{T`Personal`}</h2><p>{T`Preferences and security for your account.`}</p></div>
      </div>
      <div className="settings-group">
        <ThemeSection />
        <ChangePasswordSection />
      </div>
    </main>
  )
}

/**
 * User administration on its own page, since the table grows with the
 * deployment. Admins only.
 */
export function UsersPage({ user }: { user: User }) {
  return (
    <main className="list-page">
      <div className="session-head">
        <h1>{T`Users`}</h1>
        <span className="session-actions">
          <a href="#/settings">← {T`Settings`}</a>
        </span>
      </div>
      {user.role === "admin" ? (
        <UsersSection currentUser={user} />
      ) : (
        <p className="dim">{T`Only administrators can manage users.`}</p>
      )}
    </main>
  )
}

/** Props for the languages section. */
interface LanguagesSectionProps {
  /** True for admins: controls are enabled */
  isAdmin: boolean
  /** Currently offered locale codes */
  locales: string[]
  /** The release ceiling: locales this build can render */
  supportedLocales: { code: string; name: string }[]
  /** Background catalog translation state at page load */
  translation: CatalogTranslation
  /** Reflects a successful save into the page state */
  onChange: (locales: string[]) => void
}

/**
 * Offered languages: what the language picker shows and what the data catalog
 * is translated into. A subset of what this release's interface supports.
 */
function LanguagesSection({ isAdmin, locales, supportedLocales, translation, onChange }: LanguagesSectionProps) {
  const [draft, setDraft] = useState<string[]>(locales)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<CatalogTranslation>(translation)

  function toggle(code: string) {
    setDraft(d => (d.includes(code) ? d.filter(c => c !== code) : [...d, code]))
  }

  // A translation pass runs on the server after a language is added and
  // outlasts any single request; poll until it settles
  useEffect(() => {
    if (!job.running) return
    const timer = setInterval(() => {
      getSettings().then(r => setJob(r.catalogTranslation), () => {})
    }, 4000)
    return () => clearInterval(timer)
  }, [job.running])

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await setLocalesSetting(draft)
      onChange(result.locales)
      setDraft(result.locales)
      setJob(result.catalogTranslation)
      const names = result.added.map(code => supportedLocales.find(l => l.code === code)?.name ?? code)
      setNotice(
        result.added.length > 0 && result.catalogTranslation.running
          ? T`Saved. Translating the data catalog into ${names.join(", ")} in the background; this takes a few minutes.`
          : result.added.length > 0
            ? T`Saved. No model is configured, so the data catalog stays untranslated for ${names.join(", ")}.`
            : T`Saved.`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** One line on the last or running translation pass. */
  function jobLine(): string | null {
    if (job.running) return T`Translating the data catalog…`
    if (!job.result || !job.finishedAt) return null
    const when = formatDateTime(job.finishedAt)
    if (job.result.failures.length > 0)
      return T`Last catalog translation (${when}): ${job.result.translations} strings written; failed: ${job.result.failures.join("; ")}`
    if (job.result.translations === 0) return T`Last catalog translation (${when}): nothing was missing.`
    return T`Last catalog translation (${when}): ${job.result.translations} strings across ${job.result.integrations} integrations.`
  }

  const dirty = draft.slice().sort().join(",") !== locales.slice().sort().join(",")

  return (
    <SettingsRow id="settings-languages" title={T`Languages`} description={T`Choose the languages available in the language picker and data catalog.`}>
      {error && <div className="error">{error}</div>}
      <div className="locale-checks">
        {supportedLocales.map(locale => (
          <label key={locale.code}>
            <input
              type="checkbox"
              disabled={!isAdmin || busy}
              checked={draft.includes(locale.code)}
              onChange={() => toggle(locale.code)}
            />{" "}
            {locale.name}
          </label>
        ))}
      </div>
      {isAdmin && (
        <div className="aoi-actions">
          <button onClick={() => void save()} disabled={busy || !dirty || draft.length === 0}>
            {busy ? T`Saving…` : T`Save Changes`}
          </button>
        </div>
      )}
      <p className="dim">{T`Adding a language starts a background translation of the data catalog.`}</p>
      {notice && <p className="dim" role="status">{notice}</p>}
      {isAdmin && jobLine() && <details className="settings-details"><summary>{T`Translation details`}</summary><p>{jobLine()}</p></details>}
    </SettingsRow>
  )
}

/** A days field's text for a policy value; blank when the rule is off. */
function daysText(value: number | null): string {
  return value === null ? "" : String(value)
}

/** Parses a days field: null when blank, undefined when invalid. */
function parseDays(text: string): number | null | undefined {
  if (text.trim() === "") return null
  const days = Number(text)
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined
}

/** Admin form: optional password expiry and inactivity disabling, both off by default. */
function AccountPolicySection() {
  const [saved, setSaved] = useState<AccountPolicy | null>(null)
  const [maxAge, setMaxAge] = useState("")
  const [inactive, setInactive] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(false)

  function reset(policy: AccountPolicy) {
    setSaved(policy)
    setMaxAge(daysText(policy.passwordMaxAgeDays))
    setInactive(daysText(policy.inactiveDisableDays))
  }

  useEffect(() => {
    getAccountPolicy().then(reset, err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const maxAgeDays = parseDays(maxAge)
  const inactiveDays = parseDays(inactive)
  const valid = maxAgeDays !== undefined && inactiveDays !== undefined
  const dirty = saved !== null && (maxAge !== daysText(saved.passwordMaxAgeDays) || inactive !== daysText(saved.inactiveDisableDays))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    setNotice(false)
    try {
      reset(await saveAccountPolicy({ passwordMaxAgeDays: maxAgeDays, inactiveDisableDays: inactiveDays }))
      setNotice(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      id="settings-account-policy"
      title={T`Account policy`}
      description={T`Optional rules for deployments whose security policy requires them. Both are off by default; leave a field blank to keep it off.`}
    >
      {error && <div className="error" role="alert">{error}</div>}
      {saved && (
        <form className="password-form" onSubmit={submit}>
          <label>
            {T`Require a new password after (days)`}
            <input type="number" min="1" max="3650" step="1" value={maxAge} onChange={e => { setMaxAge(e.target.value); setNotice(false) }} aria-invalid={maxAgeDays === undefined} />
          </label>
          <label>
            {T`Disable accounts inactive for (days)`}
            <input type="number" min="1" max="3650" step="1" value={inactive} onChange={e => { setInactive(e.target.value); setNotice(false) }} aria-invalid={inactiveDays === undefined} />
          </label>
          <p className="dim">{T`Signing in and API use count as activity. Administrators are disabled only while another administrator remains active. Re-enable accounts from Manage Users.`}</p>
          <div className="settings-actions">
            <button disabled={busy || !dirty || !valid}>{busy ? T`Saving…` : T`Save Changes`}</button>
            {notice && <span className="dim" role="status">{T`Saved.`}</span>}
          </div>
        </form>
      )}
    </SettingsRow>
  )
}

/** Self-service password change, proving the current password. */
function ChangePasswordSection() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (next.length < 8) {
      setError(T`Password must be at least 8 characters`)
      return
    }
    if (next !== confirm) {
      setError(T`New passwords do not match`)
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setCurrent("")
      setNext("")
      setConfirm("")
      setNotice(T`Password changed.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow id="settings-password" title={T`Password`} description={T`Use a password with at least 8 characters.`}>
      {error && <div className="error">{error}</div>}
      <form className="password-form" onSubmit={submit}>
        <label>
          {T`Current password`}
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            required
          />
        </label>
        <label>
          {T`New password`}
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={e => setNext(e.target.value)}
            required
          />
        </label>
        <label>
          {T`Confirm new password`}
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />
        </label>
        <button disabled={busy || !current || !next || !confirm}>{T`Change Password`}</button>
        {notice && <p className="dim" role="status">{notice}</p>}
      </form>
    </SettingsRow>
  )
}

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
  User
} from "./api.js"
import { ThemePreference, useAppTheme } from "./theme.js"
import { formatDateTime, setOfferedLocales } from "./localization.js"
import { UsersSection } from "./UsersSection.js"

/** Shown as the home page title when the deployment has not set one. */
const DEFAULT_SITE_TITLE = "Data Integrator"

/**
 * The deployment's display name, shown as the home page heading. Blank restores
 * the default, so there is no separate clear action.
 */
function SiteTitleSection({ initial, isAdmin }: { initial: string | null; isAdmin: boolean }) {
  const [title, setTitle] = useState(initial ?? "")
  const [saved, setSaved] = useState(initial)
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>{T`Deployment name`}</h2>
      <p className="dim">
        {T`The heading on the home page. Name it after the deployment, for example "Madagascar Data Integrator".`}
      </p>
      <p>
        {T`Current:`} <b>{saved ?? DEFAULT_SITE_TITLE}</b>
        {saved === null && <span className="dim"> {T`(default)`}</span>}
      </p>
      {error && <div className="error">{error}</div>}
      {isAdmin ? (
        <form className="title-form" onSubmit={save}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={DEFAULT_SITE_TITLE}
            maxLength={120}
            aria-label={T`Deployment name`}
          />
          <button disabled={busy || title.trim() === (saved ?? "")}>{T`Save`}</button>
          <span className="dim">{T`Leave blank to use “${DEFAULT_SITE_TITLE}”.`}</span>
        </form>
      ) : (
        <p className="dim">{T`Only administrators can change settings.`}</p>
      )}
    </>
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
    <section className="settings-section" id="settings-theme">
      <h2>{T`Theme`}</h2>
      <p className="dim">{T`Changes the appearance for you on this device only.`}</p>
      <select
        value={preference}
        onChange={e => setPreference(e.target.value as ThemePreference)}
        aria-label={T`Theme`}
      >
        <option value="light">{T`Light`}</option>
        <option value="dark">{T`Dark`}</option>
        <option value="system">{T`Match system`}</option>
      </select>
    </section>
  )
}

/**
 * Deployment settings. The default area of interest scopes every integration
 * installed without an AOI of its own; admins pick a country from the built-in
 * list or enter a custom bounding box.
 */
export function Settings({ user }: { user: User }) {
  const [current, setCurrent] = useState<DefaultAoi | null>(null)
  const [siteTitle, setSiteTitleState] = useState<string | null>(null)
  const [locales, setLocales] = useState<string[]>([])
  const [supportedLocales, setSupportedLocales] = useState<{ code: string; name: string }[]>([])
  const [translation, setTranslation] = useState<CatalogTranslation | null>(null)
  const [countries, setCountries] = useState<CountryBox[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Editor state: a country selection or a custom box
  const [mode, setMode] = useState<"country" | "custom">("country")
  const [iso3, setIso3] = useState("")
  const [custom, setCustom] = useState({ west: "", south: "", east: "", north: "" })

  const isAdmin = user.role === "admin"

  useEffect(() => {
    Promise.all([getSettings(), listCountries()]).then(
      ([settings, countryList]) => {
        setCurrent(settings.settings.default_aoi)
        setSiteTitleState(settings.settings.site_title)
        setLocales(settings.settings.locales)
        setSupportedLocales(settings.supportedLocales)
        setTranslation(settings.catalogTranslation)
        setCountries(countryList.countries)
        setLoaded(true)
      },
      err => setError(err.message)
    )
  }, [])

  const selected = useMemo(() => countries.find(c => c.iso3 === iso3) ?? null, [countries, iso3])

  async function save() {
    setError(null)
    setNotice(null)
    try {
      let aoi: DefaultAoi
      if (mode === "country") {
        if (!selected) throw new Error(T`Pick a country first`)
        aoi = { bbox: selected.bbox, countries: [selected.iso3], name: selected.name }
      } else {
        const values = [custom.west, custom.south, custom.east, custom.north].map(Number)
        if (values.some(v => !Number.isFinite(v)))
          throw new Error(T`All four bbox values are required`)
        aoi = { bbox: values as [number, number, number, number] }
      }
      const result = await setDefaultAoi(aoi)
      setCurrent(result.default_aoi)
      setNotice(T`Saved. Future runs of integrations without their own AOI use this area.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function clear() {
    setError(null)
    setNotice(null)
    try {
      await clearDefaultAoi()
      setCurrent(null)
      setNotice(T`Cleared. Integrations without an AOI ingest their source's full extent.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Scrolls to a section without touching the route hash. */
  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const sections: [string, string][] = [
    ["settings-title", T`Deployment name`],
    ["settings-aoi", T`Area of interest`],
    ["settings-languages", T`Languages`],
    ["settings-theme", T`Theme`],
    ["settings-password", T`Password`]
  ]

  return (
    <main className="list-page">
      <h1>{T`Settings`}</h1>
      <nav className="settings-nav" aria-label={T`Settings sections`}>
        {sections.map(([id, label]) => (
          <a key={id} href="#/settings" onClick={e => { e.preventDefault(); jump(id) }}>
            {label}
          </a>
        ))}
        {isAdmin && <a href="#/settings/users">{T`Users`}</a>}
      </nav>
      {error && <div className="error">{error}</div>}
      {!loaded ? (
        <p>{T`Loading…`}</p>
      ) : (
        <>
          <div id="settings-title">
            <SiteTitleSection initial={siteTitle} isAdmin={isAdmin} />
          </div>

          <h2 id="settings-aoi">{T`Default area of interest`}</h2>
          <p className="dim">
            {T`Integrations installed without an area of interest are clipped to this at run time. Set it once to point every library integration at your country. Any integration can declare its own area instead, so this is a default, not a limit.`}
          </p>
          <p>
            {T`Current:`}{" "}
            {current ? (
              <b>
                {current.name ?? current.countries?.join(", ") ?? T`custom`} {formatBbox(current.bbox)}
              </b>
            ) : (
              <span className="dim">{T`none — integrations ingest their source's full extent`}</span>
            )}
          </p>
          {isAdmin ? (
            <div className="aoi-editor">
              <div className="aoi-mode">
                <label>
                  <input
                    type="radio"
                    checked={mode === "country"}
                    onChange={() => setMode("country")}
                  />{" "}
                  {T`Country`}
                </label>
                <label>
                  <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} />{" "}
                  {T`Custom bounding box`}
                </label>
              </div>
              {mode === "country" ? (
                <select value={iso3} onChange={e => setIso3(e.target.value)}>
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
                <button onClick={save}>{T`Save`}</button>
                {current && (
                  <button className="secondary" onClick={clear}>
                    {T`Clear`}
                  </button>
                )}
              </div>
              {notice && <p className="dim">{notice}</p>}
            </div>
          ) : (
            <p className="dim">{T`Only administrators can change settings.`}</p>
          )}
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
      <ThemeSection />
      <ChangePasswordSection />
    </main>
  )
}

/**
 * User administration on its own page: the table grows with the deployment,
 * so it no longer shares the scrolling settings page. Admins only.
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
    <section className="settings-section" id="settings-languages">
      <h2>{T`Languages`}</h2>
      <p className="dim">
        {T`Languages this deployment offers. The language picker shows them, and the data catalog (names, descriptions, caveats) is translated into each one automatically when you add it. Interface languages are fixed per release; this narrows the offer.`}
      </p>
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
            {T`Save`}
          </button>
        </div>
      )}
      {notice && <p className="dim">{notice}</p>}
      {isAdmin && jobLine() && <p className="dim">{jobLine()}</p>}
    </section>
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
    <section className="settings-section" id="settings-password">
      <h2>{T`Change password`}</h2>
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
        {notice && <p className="dim">{notice}</p>}
      </form>
    </section>
  )
}

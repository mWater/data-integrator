import { FormEvent, useEffect, useMemo, useState } from "react"
import {
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
      <h2>Deployment name</h2>
      <p className="dim">
        The heading on the home page. Name it after the deployment, for example "Madagascar Data
        Integrator".
      </p>
      <p>
        Current: <b>{saved ?? DEFAULT_SITE_TITLE}</b>
        {saved === null && <span className="dim"> (default)</span>}
      </p>
      {error && <div className="error">{error}</div>}
      {isAdmin ? (
        <form className="title-form" onSubmit={save}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={DEFAULT_SITE_TITLE}
            maxLength={120}
            aria-label="Deployment name"
          />
          <button disabled={busy || title.trim() === (saved ?? "")}>Save</button>
          <span className="dim">Leave blank to use “{DEFAULT_SITE_TITLE}”.</span>
        </form>
      ) : (
        <p className="dim">Only administrators can change settings.</p>
      )}
    </>
  )
}

/** Formats a bbox for display. */
function formatBbox(bbox: [number, number, number, number]): string {
  return `[${bbox.map(v => v.toFixed(2)).join(", ")}]`
}

/**
 * Deployment settings. The default area of interest scopes every integration
 * installed without an AOI of its own; admins pick a country from the built-in
 * list or enter a custom bounding box.
 */
export function Settings({ user }: { user: User }) {
  const [current, setCurrent] = useState<DefaultAoi | null>(null)
  const [siteTitle, setSiteTitleState] = useState<string | null>(null)
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
        if (!selected) throw new Error("Pick a country first")
        aoi = { bbox: selected.bbox, countries: [selected.iso3], name: selected.name }
      } else {
        const values = [custom.west, custom.south, custom.east, custom.north].map(Number)
        if (values.some(v => !Number.isFinite(v))) throw new Error("All four bbox values are required")
        aoi = { bbox: values as [number, number, number, number] }
      }
      const result = await setDefaultAoi(aoi)
      setCurrent(result.default_aoi)
      setNotice("Saved. Future runs of integrations without their own AOI use this area.")
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
      setNotice("Cleared. Integrations without an AOI ingest their source's full extent.")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="list-page">
      <h1>Settings</h1>
      {error && <div className="error">{error}</div>}
      {!loaded ? (
        <p>Loading…</p>
      ) : (
        <>
          <SiteTitleSection initial={siteTitle} isAdmin={isAdmin} />

          <h2>Default area of interest</h2>
          <p className="dim">
            Integrations installed without an area of interest are clipped to this at run
            time. Set it once to point every library integration at your country.
          </p>
          <p>
            Current:{" "}
            {current ? (
              <b>
                {current.name ?? current.countries?.join(", ") ?? "custom"} {formatBbox(current.bbox)}
              </b>
            ) : (
              <span className="dim">none — integrations ingest their source's full extent</span>
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
                  Country
                </label>
                <label>
                  <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} />{" "}
                  Custom bounding box
                </label>
              </div>
              {mode === "country" ? (
                <select value={iso3} onChange={e => setIso3(e.target.value)}>
                  <option value="">Pick a country…</option>
                  {countries.map(c => (
                    <option key={c.iso3} value={c.iso3}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
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
                {current && (
                  <button className="secondary" onClick={clear}>
                    Clear
                  </button>
                )}
              </div>
              {notice && <p className="dim">{notice}</p>}
            </div>
          ) : (
            <p className="dim">Only administrators can change settings.</p>
          )}
        </>
      )}
      {isAdmin && <UsersSection currentUser={user} />}
      <ChangePasswordSection />
    </main>
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
      setError("Password must be at least 8 characters")
      return
    }
    if (next !== confirm) {
      setError("New passwords do not match")
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setCurrent("")
      setNext("")
      setConfirm("")
      setNotice("Password changed.")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Change password</h2>
      {error && <div className="error">{error}</div>}
      <form className="password-form" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={e => setNext(e.target.value)}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />
        </label>
        <button disabled={busy || !current || !next || !confirm}>Change Password</button>
        {notice && <p className="dim">{notice}</p>}
      </form>
    </section>
  )
}

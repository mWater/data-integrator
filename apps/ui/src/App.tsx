import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { getMe, logout, User } from "./api.js"
import { applyLocale, availableLocales, getSavedLocale, loadCronLocale } from "./localization.js"
import { AssistantPage } from "./AssistantPage.js"
import { DashboardList } from "./DashboardList.js"
import { DashboardView } from "./DashboardView.js"
import { DataSources } from "./DataSources.js"
import { Home } from "./Home.js"
import { IntegrationList } from "./IntegrationList.js"
import { IntegrationView } from "./IntegrationView.js"
import { Login } from "./Login.js"
import { SessionList } from "./SessionList.js"
import { SessionView } from "./SessionView.js"
import { Settings } from "./Settings.js"
import { TablePage } from "./TablePage.js"
import { Library } from "./Library.js"
import { UserMenu } from "./UserMenu.js"

// The layer page owns the maplibre chunk; keep it out of the first paint
const LayerPage = lazy(() => import("./LayerPage.js").then(m => ({ default: m.LayerPage })))

/** Parsed hash route. */
interface Route {
  /** Design session id, when on a session page */
  sessionId: string | null
  /** Integration id, when on an integration page */
  integrationId: string | null
  /** Destination table id, when on a table page */
  tableId: string | null
  /** True on the sessions list page */
  sessions: boolean
  /** True on the data catalog page */
  data: boolean
  /** True on the assistant page */
  assistant: boolean
  /** True on the integrations list page */
  integrations: boolean
  /** True on the dashboards list page */
  dashboards: boolean
  /** Dashboard id, when on a dashboard viewer page */
  dashboardId: string | null
  /** True on the settings page */
  settings: boolean
  /** True on the library page */
  library: boolean
  /** Raster layer id, when on a layer page */
  layerId: string | null
  /** Design session whose scratch layer the page shows (?session=) */
  layerSessionId: string | null
}

/** Current location parsed from the hash. */
function parseHash(): Route {
  const [hash, query] = window.location.hash.split("?")
  const session = hash.match(/^#\/session\/([0-9a-f-]+)$/)
  const integration = hash.match(/^#\/integration\/([a-z][a-z0-9_]*)$/)
  const table = hash.match(/^#\/table\/([a-z][a-z0-9_]*)$/)
  const dashboard = hash.match(/^#\/dashboard\/([a-z][a-z0-9_-]*)$/)
  const layer = hash.match(/^#\/layer\/([a-z][a-z0-9_]*)$/)
  return {
    sessionId: session ? session[1] : null,
    integrationId: integration ? integration[1] : null,
    tableId: table ? table[1] : null,
    sessions: hash === "#/sessions",
    data: hash === "#/data",
    assistant: hash === "#/assistant",
    integrations: hash === "#/integrations",
    dashboards: hash === "#/dashboards",
    dashboardId: dashboard ? dashboard[1] : null,
    settings: hash === "#/settings",
    library: hash === "#/library",
    layerId: layer ? layer[1] : null,
    layerSessionId: layer ? new URLSearchParams(query ?? "").get("session") : null
  }
}

/** Navbar language picker: switches the interface locale for this browser. */
function LanguageToggle({
  locale,
  onLocaleChange
}: {
  locale: string
  onLocaleChange: (code: string) => void
}) {
  return (
    <label className="lang-picker" title={T`Language`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3c2.5 2.4 3.9 5.6 3.9 9s-1.4 6.6-3.9 9c-2.5-2.4-3.9-5.6-3.9-9s1.4-6.6 3.9-9Z" />
      </svg>
      <select value={locale} onChange={e => onLocaleChange(e.target.value)} aria-label={T`Language`}>
        {availableLocales().map(l => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Hash-routed app shell behind sign-in. */
export function App() {
  const [route, setRoute] = useState(parseHash())
  const [user, setUser] = useState<User | null | "loading">("loading")

  // Locale lives in state so switching re-renders every localized string;
  // applyLocale repoints the global T before children render.
  const [locale, setLocale] = useState(getSavedLocale)
  useMemo(() => applyLocale(locale), [locale])

  // Cron descriptions come from cronstrue's separately-loaded locale bundle;
  // re-render once it arrives so schedules stop showing in English.
  const [, setCronLoaded] = useState(0)
  useEffect(() => {
    loadCronLocale(locale).then(changed => changed && setCronLoaded(n => n + 1))
  }, [locale])

  useEffect(() => {
    getMe().then(setUser)
    const onChange = () => setRoute(parseHash())
    const onAuthRequired = () => setUser(null)
    window.addEventListener("hashchange", onChange)
    window.addEventListener("auth:required", onAuthRequired)
    return () => {
      window.removeEventListener("hashchange", onChange)
      window.removeEventListener("auth:required", onAuthRequired)
    }
  }, [])

  if (user === "loading") return null
  if (user === null) return <Login onLogin={setUser} />

  const canDesign = user.role !== "viewer"
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">Data Integrator</a>
        <nav>
          <a href="#/">{T`Home`}</a>
          <a href="#/data">{T`Data`}</a>
          <a href="#/assistant">{T`Assistant`}</a>
          <a href="#/integrations">{T`Integrations`}</a>
          <a href="#/library">{T`Library`}</a>
          <a href="#/dashboards">{T`Dashboards`}</a>
        </nav>
        <span style={{ flex: 1 }} />
        <LanguageToggle locale={locale} onLocaleChange={setLocale} />
        <UserMenu user={user} onSignOut={() => logout().finally(() => setUser(null))} />
      </header>
      {route.sessionId ? (
        <SessionView sessionId={route.sessionId} canDesign={canDesign} />
      ) : route.integrationId ? (
        <IntegrationView integrationId={route.integrationId} canDesign={canDesign} />
      ) : route.tableId ? (
        <TablePage tableId={route.tableId} />
      ) : route.layerId ? (
        <Suspense fallback={null}>
          <LayerPage layerId={route.layerId} sessionId={route.layerSessionId} />
        </Suspense>
      ) : route.assistant ? (
        <AssistantPage />
      ) : route.dashboardId ? (
        <DashboardView dashboardId={route.dashboardId} />
      ) : route.dashboards ? (
        <DashboardList canDesign={canDesign} />
      ) : route.library ? (
        <Library user={user} />
      ) : route.settings ? (
        <Settings user={user} />
      ) : route.sessions ? (
        <SessionList />
      ) : route.integrations ? (
        <IntegrationList canDesign={canDesign} />
      ) : route.data ? (
        <DataSources />
      ) : (
        <Home user={user} />
      )}
    </div>
  )
}

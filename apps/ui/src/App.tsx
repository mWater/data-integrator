import { useEffect, useState } from "react"
import { getMe, logout, User } from "./api.js"
import { ThemePreference, useAppTheme } from "./theme.js"
import { DashboardList } from "./DashboardList.js"
import { DashboardView } from "./DashboardView.js"
import { DataSources } from "./DataSources.js"
import { IntegrationList } from "./IntegrationList.js"
import { IntegrationView } from "./IntegrationView.js"
import { Login } from "./Login.js"
import { MapPage } from "./MapPage.js"
import { SessionList } from "./SessionList.js"
import { SessionView } from "./SessionView.js"
import { Settings } from "./Settings.js"
import { Library } from "./Library.js"
import { UserMenu } from "./UserMenu.js"

/** Parsed hash route. */
interface Route {
  /** Design session id, when on a session page */
  sessionId: string | null
  /** Integration id, when on an integration page */
  integrationId: string | null
  /** True on the sessions list page */
  sessions: boolean
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
  /** True on the map page */
  map: boolean
  /** Layer to focus when opening the map from an integration */
  mapLayerId: string | null
  /** Design session whose scratch layers the map shows (?session=) */
  mapSessionId: string | null
}

/** Current location parsed from the hash. */
function parseHash(): Route {
  const [hash, query] = window.location.hash.split("?")
  const session = hash.match(/^#\/session\/([0-9a-f-]+)$/)
  const integration = hash.match(/^#\/integration\/([a-z][a-z0-9_]*)$/)
  const dashboard = hash.match(/^#\/dashboard\/([a-z][a-z0-9_-]*)$/)
  const map = hash.match(/^#\/map(?:\/([a-z][a-z0-9_]*))?$/)
  return {
    sessionId: session ? session[1] : null,
    integrationId: integration ? integration[1] : null,
    sessions: hash === "#/sessions",
    integrations: hash === "#/integrations",
    dashboards: hash === "#/dashboards",
    dashboardId: dashboard ? dashboard[1] : null,
    settings: hash === "#/settings",
    library: hash === "#/library",
    map: map !== null,
    mapLayerId: map?.[1] ?? null,
    mapSessionId: map ? new URLSearchParams(query ?? "").get("session") : null
  }
}

/** Cycle order for the theme toggle. */
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light"
}

/** Navbar theme toggle: cycles light, dark, system. */
function ThemeToggle() {
  const { preference, setPreference } = useAppTheme()
  const label =
    preference === "system" ? "Theme: system" : preference === "dark" ? "Theme: dark" : "Theme: light"
  return (
    <button
      className="theme-toggle"
      title={label}
      aria-label={label}
      onClick={() => setPreference(NEXT_PREFERENCE[preference])}
    >
      {preference === "light" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </svg>
      ) : preference === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M9 21h6M12 17v4" />
        </svg>
      )}
    </button>
  )
}

/** Hash-routed app shell behind sign-in. */
export function App() {
  const [route, setRoute] = useState(parseHash())
  const [user, setUser] = useState<User | null | "loading">("loading")

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
          <a href="#/">Data</a>
          <a href="#/integrations">Integrations</a>
          <a href="#/library">Library</a>
          <a href="#/dashboards">Dashboards</a>
          <a href="#/map">Map</a>
        </nav>
        <span style={{ flex: 1 }} />
        <ThemeToggle />
        <UserMenu user={user} onSignOut={() => logout().finally(() => setUser(null))} />
      </header>
      {route.sessionId ? (
        <SessionView sessionId={route.sessionId} canDesign={canDesign} />
      ) : route.integrationId ? (
        <IntegrationView integrationId={route.integrationId} canDesign={canDesign} />
      ) : route.map ? (
        <MapPage focusLayerId={route.mapLayerId} sessionId={route.mapSessionId} />
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
      ) : (
        <DataSources />
      )}
    </div>
  )
}

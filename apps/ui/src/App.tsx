import { useEffect, useState } from "react"
import { getMe, logout, User } from "./api.js"
import { IntegrationList } from "./IntegrationList.js"
import { IntegrationView } from "./IntegrationView.js"
import { Login } from "./Login.js"
import { MapPage } from "./MapPage.js"
import { SessionList } from "./SessionList.js"
import { SessionView } from "./SessionView.js"

/** Parsed hash route. */
interface Route {
  /** Design session id, when on a session page */
  sessionId: string | null
  /** Integration id, when on an integration page */
  integrationId: string | null
  /** True on the sessions list page */
  sessions: boolean
  /** True on the map page */
  map: boolean
  /** Layer to focus when opening the map from an integration */
  mapLayerId: string | null
}

/** Current location parsed from the hash. */
function parseHash(): Route {
  const hash = window.location.hash
  const session = hash.match(/^#\/session\/([0-9a-f-]+)$/)
  const integration = hash.match(/^#\/integration\/([a-z][a-z0-9_]*)$/)
  const map = hash.match(/^#\/map(?:\/([a-z][a-z0-9_]*))?$/)
  return {
    sessionId: session ? session[1] : null,
    integrationId: integration ? integration[1] : null,
    sessions: hash === "#/sessions",
    map: map !== null,
    mapLayerId: map?.[1] ?? null
  }
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
          <a href="#/">Integrations</a>
          <a href="#/sessions">Agent activity</a>
          <a href="#/map">Map</a>
        </nav>
        <span style={{ flex: 1 }} />
        <span className="user-email">{user.email}</span>
        <button
          className="linkish"
          onClick={() => logout().finally(() => setUser(null))}
        >
          Sign Out
        </button>
      </header>
      {route.sessionId ? (
        <SessionView sessionId={route.sessionId} canDesign={canDesign} />
      ) : route.integrationId ? (
        <IntegrationView integrationId={route.integrationId} canDesign={canDesign} />
      ) : route.map ? (
        <MapPage focusLayerId={route.mapLayerId} />
      ) : route.sessions ? (
        <SessionList />
      ) : (
        <IntegrationList canDesign={canDesign} />
      )}
    </div>
  )
}

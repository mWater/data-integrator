import { useEffect, useState } from "react"
import { IntegrationList } from "./IntegrationList.js"
import { IntegrationView } from "./IntegrationView.js"
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
}

/** Current location parsed from the hash. */
function parseHash(): Route {
  const hash = window.location.hash
  const session = hash.match(/^#\/session\/([0-9a-f-]+)$/)
  const integration = hash.match(/^#\/integration\/([a-z][a-z0-9_]*)$/)
  return {
    sessionId: session ? session[1] : null,
    integrationId: integration ? integration[1] : null,
    sessions: hash === "#/sessions"
  }
}

/** Hash-routed app shell: integrations (landing), sessions, and detail pages. */
export function App() {
  const [route, setRoute] = useState(parseHash())

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">Data Integrator</a>
        <nav>
          <a href="#/">Integrations</a>
          <a href="#/sessions">Sessions</a>
          <a href="/map" target="_blank" rel="noreferrer">Map</a>
        </nav>
      </header>
      {route.sessionId ? (
        <SessionView sessionId={route.sessionId} />
      ) : route.integrationId ? (
        <IntegrationView integrationId={route.integrationId} />
      ) : route.sessions ? (
        <SessionList />
      ) : (
        <IntegrationList />
      )}
    </div>
  )
}

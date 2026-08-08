import { useEffect, useState } from "react"
import { SessionList } from "./SessionList.js"
import { SessionView } from "./SessionView.js"

/** Current location parsed from the hash: #/session/<id> or the list. */
function parseHash(): { sessionId: string | null } {
  const match = window.location.hash.match(/^#\/session\/([0-9a-f-]+)$/)
  return { sessionId: match ? match[1] : null }
}

/** Hash-routed app shell: session list or a single design session. */
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
          <a href="#/">Sessions</a>
          <a href="/map" target="_blank" rel="noreferrer">Map</a>
        </nav>
      </header>
      {route.sessionId ? <SessionView sessionId={route.sessionId} /> : <SessionList />}
    </div>
  )
}

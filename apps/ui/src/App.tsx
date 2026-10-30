import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { AiInfo, getMe, getSettings, logout, User } from "./api.js"
import { applyLocale, availableLocales, getSavedLocale, loadCronLocale, setOfferedLocales } from "./localization.js"
import { AiAckHost, setAiInfo } from "./aiAck.js"
import { AiPrivacy } from "./AiPrivacy.js"
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
import { Settings, UsersPage } from "./Settings.js"
import { TablePage } from "./TablePage.js"
import { Library } from "./Library.js"
import { HowItWorks } from "./HowItWorks.js"
import { DesignStart } from "./DesignStart.js"
import { UserMenu } from "./UserMenu.js"
import { allowHashChange } from "./navGuard.js"

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
  /** True on the Explore page (plain-language questions over the data) */
  ask: boolean
  /** True on the integrations list page */
  integrations: boolean
  /** True on the dashboards list page */
  dashboards: boolean
  /** Dashboard id, when on a dashboard viewer page */
  dashboardId: string | null
  /** True on the settings page */
  settings: boolean
  /** True on the Users page (admin) */
  settingsUsers: boolean
  /** Library entry whose install confirmation should open (#/library?install=) */
  libraryInstall: string | null
  /** Request text for a new design session (#/design?prompt=); null elsewhere */
  designPrompt: string | null
  /** True on the AI & data privacy page */
  aiPrivacy: boolean
  /** True on the library page */
  library: boolean
  /** True on the How it works page */
  howItWorks: boolean
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
    ask: hash === "#/explore",
    integrations: hash === "#/integrations",
    dashboards: hash === "#/dashboards",
    dashboardId: dashboard ? dashboard[1] : null,
    settings: hash === "#/settings",
    settingsUsers: hash === "#/settings/users",
    libraryInstall: hash === "#/library" ? new URLSearchParams(query ?? "").get("install") : null,
    designPrompt: hash === "#/design" ? (new URLSearchParams(query ?? "").get("prompt") ?? "") : null,
    aiPrivacy: hash === "#/ai-privacy",
    library: hash === "#/library",
    howItWorks: hash === "#/how-it-works",
    layerId: layer ? layer[1] : null,
    layerSessionId: layer ? new URLSearchParams(query ?? "").get("session") : null
  }
}

/** Navbar language picker: a globe that opens the deployment's offered languages. */
function LanguageToggle({
  locale,
  onLocaleChange
}: {
  locale: string
  onLocaleChange: (code: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const current = availableLocales().find(l => l.code === locale)
  return (
    <div className="lang-menu" ref={ref}>
      <button
        ref={triggerRef}
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={T`Language`}
        title={current ? `${T`Language`}: ${current.name}` : T`Language`}
        onClick={() => setOpen(o => !o)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3c2.5 2.4 3.9 5.6 3.9 9s-1.4 6.6-3.9 9c-2.5-2.4-3.9-5.6-3.9-9s1.4-6.6 3.9-9Z" />
        </svg>
        <span>{locale.toUpperCase()}</span>
      </button>
      {open && (
        <div className="user-menu-list" role="menu">
          {availableLocales().map(l => (
            <button
              key={l.code}
              role="menuitemradio"
              aria-checked={l.code === locale}
              onClick={() => {
                onLocaleChange(l.code)
                setOpen(false)
              }}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Topbar shortcut to Settings, shown to admins only. */
function SettingsGear() {
  return (
    <a className="topbar-gear" href="#/settings" title={T`Settings`} aria-label={T`Settings`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    </a>
  )
}

/** Hash-routed app shell behind sign-in. */
export function App() {
  const [route, setRoute] = useState(parseHash())
  const [user, setUser] = useState<User | null | "loading">("loading")
  const [ai, setAi] = useState<AiInfo | null>(null)

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

  // The deployment's offered languages narrow the picker whenever they change
  const [, setOfferTick] = useState(0)
  useEffect(() => {
    getMe().then(me => {
      setUser(me?.user ?? null)
      setAi(me?.ai ?? null)
      setAiInfo(me?.ai ?? null)
      if (me) getSettings().then(r => setOfferedLocales(r.settings.locales), () => {})
    })
    const onChange = () => {
      if (allowHashChange()) setRoute(parseHash())
    }
    const onAuthRequired = () => setUser(null)
    const onLocalesChanged = () => setOfferTick(n => n + 1)
    window.addEventListener("hashchange", onChange)
    window.addEventListener("auth:required", onAuthRequired)
    window.addEventListener("locales:changed", onLocalesChanged)
    return () => {
      window.removeEventListener("hashchange", onChange)
      window.removeEventListener("auth:required", onAuthRequired)
      window.removeEventListener("locales:changed", onLocalesChanged)
    }
  }, [])

  if (user === "loading") return null
  if (user === null) {
    // Public dashboards render without a session on their normal URL; the
    // server serves them only when their public flag is set
    if (route.dashboardId) {
      return (
        <div className="app">
          <header className="topbar">
            <a href="#/" className="brand">mWater Data Integrator</a>
            <span style={{ flex: 1 }} />
            <a className="topbar-signin" href="#/dashboards">{T`Sign In`}</a>
          </header>
          <DashboardView dashboardId={route.dashboardId} canDesign={false} />
        </div>
      )
    }
    return (
      <Login
        onLogin={u => {
          setUser(u)
          // The login response carries only the user; the AI wiring rides /api/me
          void getMe().then(me => {
            setAi(me?.ai ?? null)
            setAiInfo(me?.ai ?? null)
          })
        }}
      />
    )
  }

  const activeSection = route.tableId || route.layerId || route.data ? "data"
    : route.dashboardId || route.dashboards ? "dashboards"
    : route.integrationId || route.integrations || route.designPrompt !== null ? "integrations"
    : route.library ? "library" : route.ask ? "ask"
    : route.sessionId || route.sessions || route.settings || route.settingsUsers || route.aiPrivacy || route.howItWorks ? null : "home"
  const canDesign = user.role !== "viewer"
  const refreshAi = () => void getMe().then(me => {
    setAi(me?.ai ?? null)
    setAiInfo(me?.ai ?? null)
  })
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">mWater Data Integrator</a>
        <nav>
          <a href="#/" aria-current={activeSection === "home" ? "page" : undefined}>{T`Home`}</a>
          <a href="#/data" aria-current={activeSection === "data" ? "page" : undefined}>{T`Data`}</a>
          <a href="#/explore" aria-current={activeSection === "ask" ? "page" : undefined}>{T`Explore`}</a>
          <a href="#/integrations" aria-current={activeSection === "integrations" ? "page" : undefined}>{T`Integrations`}</a>
          <a href="#/library" aria-current={activeSection === "library" ? "page" : undefined}>{T`Library`}</a>
          <a href="#/dashboards" aria-current={activeSection === "dashboards" ? "page" : undefined}>{T`Dashboards`}</a>
        </nav>
        <span style={{ flex: 1 }} />
        <LanguageToggle locale={locale} onLocaleChange={setLocale} />
        {user.role === "admin" && <SettingsGear />}
        <UserMenu user={user} onSignOut={() => logout().finally(() => setUser(null))} />
      </header>
      {route.sessionId ? (
        <SessionView sessionId={route.sessionId} canDesign={canDesign} isAdmin={user.role === "admin"} userId={user.id} />
      ) : route.integrationId ? (
        <IntegrationView integrationId={route.integrationId} canDesign={canDesign} isAdmin={user.role === "admin"} />
      ) : route.tableId ? (
        <TablePage tableId={route.tableId} />
      ) : route.layerId ? (
        <Suspense fallback={null}>
          <LayerPage layerId={route.layerId} sessionId={route.layerSessionId} />
        </Suspense>
      ) : route.ask ? (
        <AssistantPage />
      ) : route.dashboardId ? (
        <DashboardView dashboardId={route.dashboardId} canDesign={canDesign} />
      ) : route.dashboards ? (
        <DashboardList canDesign={canDesign} isAdmin={user.role === "admin"} />
      ) : route.howItWorks ? (
        <HowItWorks />
      ) : route.library ? (
        <Library user={user} installId={route.libraryInstall} />
      ) : route.designPrompt !== null ? (
        <DesignStart prompt={route.designPrompt} canDesign={canDesign} />
      ) : route.settingsUsers ? (
        <UsersPage user={user} />
      ) : route.settings ? (
        <Settings user={user} ai={ai ?? { provider: null, model: null, ackRequired: false }} onAiChanged={refreshAi} />
      ) : route.aiPrivacy ? (
        <AiPrivacy ai={ai ?? { provider: null, model: null, ackRequired: false }} />
      ) : route.sessions ? (
        <SessionList />
      ) : route.integrations ? (
        <IntegrationList canDesign={canDesign} />
      ) : route.data ? (
        <DataSources />
      ) : (
        <Home user={user} />
      )}
      <AiAckHost />
    </div>
  )
}

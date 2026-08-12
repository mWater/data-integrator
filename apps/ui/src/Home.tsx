/**
 * Landing page. Two states: a welcome that explains where data comes from
 * while there is none, and an action-first page once there is. Everything
 * comes from one GET /api/home so the page renders in a single round trip.
 */

import { ReactNode, useEffect, useState } from "react"
import {
  createDashboardSession,
  createSession,
  getHome,
  HomeIntegration,
  HomeProblem,
  HomeSource,
  HomeSummary,
  User
} from "./api.js"

/** Problems listed before the rest collapse into a count. */
const PROBLEM_LIMIT = 2

/** Short relative age of an ISO timestamp, or null when there is none. */
function since(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" })
}

/** Greeting for the local time of day. */
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/** "1 row" / "2 rows", so counts read as sentences. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** What a source holds: rows for tables, promoted snapshots for layers. */
function contents(source: HomeSource): string {
  return source.kind === "table"
    ? plural(source.rows ?? 0, "row")
    : plural(source.snapshots ?? 0, "snapshot")
}

/** Status dot class for an integration's most recent run. */
function runTone(status: string | null): string {
  if (status === null) return "dot idle"
  if (status === "running" || status === "queued") return "dot run"
  if (status === "failed" || status === "timeout") return "dot bad"
  return "dot"
}

/** Past-tense verb for a run's terminal status, for the failure banner. */
function ended(status: string): string {
  return status === "timeout" ? "timed out" : "failed"
}

/** Icon set, sized for the action cards and route cards. */
const ICONS = {
  ask: (
    <path d="M20 4H4v12h5l3 4 3-4h5z" />
  ),
  chart: (
    <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3.2" />
      <path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6" />
      <path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" />
    </>
  ),
  agent: (
    <>
      <path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  library: (
    <path d="M4 5h6v14H4zM14 5h6v14h-6z" />
  )
}

/** One 16px line icon from the set above. */
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="card-icon" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[name]}
      </svg>
    </span>
  )
}

/** Props shared by the two card shapes: a link card and an action card. */
interface CardProps {
  /** Icon to lead with */
  icon: keyof typeof ICONS
  /** Card heading */
  title: string
  /** One-line description */
  description: string
  /** Fact strip along the bottom */
  fact: string
  /** Extra class names */
  className?: string
}

/** A card that navigates. */
function LinkCard({ href, icon, title, description, fact, className = "" }: CardProps & { href: string }) {
  return (
    <a className={`card ${className}`} href={href}>
      <span className="card-title">
        <Icon name={icon} />
        {title}
      </span>
      <span className="card-desc">{description}</span>
      <span className="card-fact">{fact}</span>
    </a>
  )
}

/** A card that runs something before navigating. */
function ActionCard({
  onClick,
  busy,
  icon,
  title,
  description,
  fact,
  className = ""
}: CardProps & { onClick: () => void; busy: boolean }) {
  return (
    <button className={`card ${className}`} onClick={onClick} disabled={busy}>
      <span className="card-title">
        <Icon name={icon} />
        {title}
      </span>
      <span className="card-desc">{description}</span>
      <span className="card-fact">{busy ? "Starting…" : fact}</span>
    </button>
  )
}

/** The data and integrations panels, shared by both states. */
function Panel({ title, link, href, children }: {
  title: string
  link: string
  href: string
  children: ReactNode
}) {
  return (
    <section className="home-panel">
      <div className="home-panel-head">
        <h2>{title}</h2>
        <a href={href}>{link}</a>
      </div>
      <div className="panel">{children}</div>
    </section>
  )
}

/** One row of the data panel. */
function SourceRow({ source }: { source: HomeSource }) {
  const href = source.kind === "raster" ? `#/map/${source.id}` : `#/table/${source.id}`
  return (
    <a className="panel-row" href={href}>
      <span className={`chip chip-${source.kind}`}>{source.kind}</span>
      <span className="grow">{source.name}</span>
      <span className="panel-fact">{contents(source)}</span>
      <span className="panel-when">{since(source.updatedAt) ?? "never"}</span>
    </a>
  )
}

/** One row of the integrations panel. */
function IntegrationRow({ integration }: { integration: HomeIntegration }) {
  const when = integration.lastRunStatus === "running" || integration.lastRunStatus === "queued"
    ? integration.lastRunStatus
    : (since(integration.lastRunAt) ?? "never run")
  return (
    <a className="panel-row" href={`#/integration/${integration.id}`}>
      <span className={runTone(integration.lastRunStatus)} />
      <span className="grow">{integration.name}</span>
      {integration.status === "draft" && <span className="chip chip-draft">draft</span>}
      {!integration.enabled && <span className="chip chip-paused">paused</span>}
      <span className="panel-when">{when}</span>
    </a>
  )
}

/** The failure banner: one line per broken integration, nothing when healthy. */
function Problems({ problems }: { problems: HomeProblem[] }) {
  if (problems.length === 0) return null
  const shown = problems.slice(0, PROBLEM_LIMIT)
  return (
    <div className="home-alerts">
      {shown.map(problem => (
        <a className="home-alert" key={problem.id} href={`#/integration/${problem.id}`}>
          <span className="chip chip-failed">{problem.status}</span>
          <span className="grow">
            <b>{problem.name}</b> {ended(problem.status)} {since(problem.failedAt) ?? "recently"}
            {problem.error ? `. ${problem.error}` : ""}
          </span>
          <span className="home-alert-action">Look at the run</span>
        </a>
      ))}
      {problems.length > shown.length && (
        <a className="home-alert-more" href="#/integrations">
          {problems.length - shown.length} more integration
          {problems.length - shown.length === 1 ? " is" : "s are"} failing
        </a>
      )}
    </div>
  )
}

/** Welcome state: no data has landed yet. */
function Welcome({ home, canDesign }: { home: HomeSummary; canDesign: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const waiting = home.counts.integrations > 0

  async function design() {
    setBusy(true)
    setError(null)
    try {
      const { sessionId } = await createSession()
      window.location.hash = `#/session/${sessionId}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const canAgent = canDesign && home.ai.designer
  const canLibrary = home.counts.library !== null && home.counts.library > 0 && canDesign

  return (
    <main className="home home-welcome">
      <h1>{waiting ? "No data yet" : "Let's get some data in"}</h1>
      <p className="home-lede">
        {waiting
          ? `${plural(home.counts.integrations, "integration")} set up, but nothing has landed yet.
             Data appears here after a run finishes.`
          : `Nothing has been ingested yet. Data arrives through integrations: small pipelines that
             fetch from a source and keep it current on a schedule.`}
      </p>
      {error && <div className="error">{error}</div>}

      {waiting ? (
        <Panel title="Your integrations" link="Manage" href="#/integrations">
          {home.integrations.map(i => (
            <IntegrationRow key={i.id} integration={i} />
          ))}
        </Panel>
      ) : (
        <div className="home-routes">
          {canAgent && (
            <ActionCard
              className="primary"
              onClick={() => void design()}
              busy={busy}
              icon="agent"
              title="Describe what you need"
              description="Say where the data lives. The agent writes the pipeline, tests it, and shows you the result before anything is saved."
              fact="Works for any source"
            />
          )}
          {canLibrary && (
            <LinkCard
              href="#/library"
              icon="library"
              title="Start from a ready-made one"
              description="Common sources are already written and tested: rainfall, population, river discharge, elevation."
              fact={`${plural(home.counts.library ?? 0, "source")} ready to install`}
            />
          )}
          {!canAgent && !canLibrary && (
            <p className="dim">
              {canDesign
                ? "No model is configured and this server has no library, so integrations have to be installed with the CLI."
                : "Ask an editor or administrator to add an integration."}
            </p>
          )}
        </div>
      )}

      <div className="home-after">
        <div className="home-flow">
          <b>Integrations</b>
          <span aria-hidden="true">→</span>
          <b>Data</b>
          <span aria-hidden="true">→</span>
          <b>Dashboards, Assistant, Map</b>
        </div>
        Once data is in, you can chart it, map it, or ask questions about it.
      </div>
    </main>
  )
}

/** Active state: data exists, so the page leads with what to do with it. */
function Active({ home, canDesign }: { home: HomeSummary; canDesign: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { counts } = home
  const sources = counts.tables + counts.rasters

  async function newDashboard() {
    setBusy(true)
    setError(null)
    try {
      const { sessionId } = await createDashboardSession()
      window.location.hash = `#/session/${sessionId}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const canBuildDashboard = canDesign && home.ai.dashboards

  return (
    <main className="home">
      <header className="home-hello">
        <h1>{greeting()}</h1>
        <p>
          {home.deployment ? `${home.deployment} · ` : ""}
          {plural(counts.integrations, "integration")} keeping {plural(sources, "data source")} current
        </p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="home-actions">
        {home.ai.assistant && (
          <LinkCard
            href="#/assistant"
            icon="ask"
            title="Ask a question"
            description="Plain language, answered from your data, with the query it ran shown."
            fact={`Reads all ${plural(sources, "data source")}`}
          />
        )}
        {canBuildDashboard ? (
          <ActionCard
            onClick={() => void newDashboard()}
            busy={busy}
            icon="chart"
            title="Build a dashboard"
            description="Charts, tables and maps you can come back to."
            fact={counts.dashboards > 0 ? `${counts.dashboards} already built` : "None yet"}
          />
        ) : counts.dashboards > 0 ? (
          <LinkCard
            href="#/dashboards"
            icon="chart"
            title="View dashboards"
            description="Charts, tables and maps built from your data."
            fact={plural(counts.dashboards, "dashboard")}
          />
        ) : null}
        <LinkCard
          href="#/data"
          icon="data"
          title="Explore your data"
          description="Browse the tables and layers directly, or open them on the map."
          fact={`${plural(counts.tables, "table")} · ${plural(counts.rasters, "raster layer")}`}
        />
      </div>

      <Problems problems={home.problems} />

      <div className="home-columns">
        <Panel title="Your data" link={`All ${sources} sources`} href="#/data">
          {home.sources.map(source => (
            <SourceRow key={`${source.kind}:${source.id}`} source={source} />
          ))}
        </Panel>
        <Panel title="Integrations" link="Manage" href="#/integrations">
          {home.integrations.map(integration => (
            <IntegrationRow key={integration.id} integration={integration} />
          ))}
        </Panel>
      </div>
    </main>
  )
}

/** Routes between the welcome and active states once the summary loads. */
export function Home({ user }: { user: User }) {
  const [home, setHome] = useState<HomeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getHome().then(setHome, (e: Error) => setError(e.message))
  }, [])

  if (error) {
    return (
      <main className="home">
        <div className="error">{error}</div>
      </main>
    )
  }
  if (!home) return null

  const canDesign = user.role !== "viewer"
  return home.hasData ? <Active home={home} canDesign={canDesign} /> : <Welcome home={home} canDesign={canDesign} />
}

import { LoadState } from "./LoadState.js"
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
  HomeCredentialNeed,
  HomeQualityIssue,
  HomeProblem,
  HomeSource,
  HomeSummary,
  User
} from "./api.js"
import { ensureAiAck } from "./aiAck.js"
import { FlowDiagram } from "./FlowDiagram.js"
import { localizeData } from "./localization.js"

/** Problems listed before the rest collapse into a count. */
const PROBLEM_LIMIT = 2

/** Short relative age of an ISO timestamp, or null when there is none. */
function since(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return T`just now`
  if (minutes < 60) return T`${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return T`${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return T`yesterday`
  if (days < 30) return T`${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" })
}

/** "1 row" / "2 rows", so counts read as sentences. Both forms are localized. */
function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** A count in the status line: the number carries ink, the noun stays quiet. */
function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <>
      <b>{n.toLocaleString()}</b> {n === 1 ? one : many}
    </>
  )
}

/** What a source holds: rows for tables, promoted snapshots for layers. */
function contents(source: HomeSource): string {
  return source.kind === "table"
    ? plural(source.rows ?? 0, T`row`, T`rows`)
    : plural(source.snapshots ?? 0, T`snapshot`, T`snapshots`)
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
  return status === "timeout" ? T`timed out` : T`failed`
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

/** Icon from the set above, on the card's tinted tile. */
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="card-tile" aria-hidden="true">
      <svg
        width="18"
        height="18"
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

/** The footer arrow: the mark that makes a card read as a control. */
function Go() {
  return (
    <span className="card-go" aria-hidden="true">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h13M12 5l7 7-7 7" />
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
      <Icon name={icon} />
      <span className="card-title">{title}</span>
      <span className="card-desc">{description}</span>
      <span className="card-foot">
        {fact}
        <Go />
      </span>
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
      <Icon name={icon} />
      <span className="card-title">{title}</span>
      <span className="card-desc">{description}</span>
      <span className="card-foot">
        {busy ? T`Starting…` : fact}
        <Go />
      </span>
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
  const href = source.kind === "raster" ? `#/layer/${source.id}` : `#/table/${source.id}`
  return (
    <a className="panel-row" href={href}>
      <span className={`chip chip-${source.kind}`}>{source.kind === "table" ? T`table` : T`raster`}</span>
      <span className="grow">{localizeData(source.name)}</span>
      <span className="panel-fact">{contents(source)}</span>
      <span className="panel-when">{since(source.updatedAt) ?? T`never`}</span>
    </a>
  )
}

/** One row of the integrations panel. */
function IntegrationRow({ integration }: { integration: HomeIntegration }) {
  const when = integration.lastRunStatus === "running" || integration.lastRunStatus === "queued"
    ? integration.lastRunStatus
    : (since(integration.lastRunAt) ?? T`never run`)
  return (
    <a className="panel-row" href={`#/integration/${integration.id}`}>
      <span className={runTone(integration.lastRunStatus)} />
      <span className="grow">{localizeData(integration.name)}</span>
      {integration.status === "draft" && <span className="chip chip-draft">{T`draft`}</span>}
      {!integration.enabled && <span className="chip chip-paused">{T`paused`}</span>}
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
            <b>{localizeData(problem.name)}</b> {ended(problem.status)} {since(problem.failedAt) ?? T`recently`}
            {problem.error ? `. ${problem.error}` : ""}
          </span>
          <span className="home-alert-action">{T`Look at the run`}</span>
        </a>
      ))}
      {problems.length > shown.length && (
        <a className="home-alert-more" href="#/integrations">
          {problems.length - shown.length === 1
            ? T`${problems.length - shown.length} more integration is failing`
            : T`${problems.length - shown.length} more integrations are failing`}
        </a>
      )}
    </div>
  )
}

/** Integrations waiting on credentials: one line each, linking to the session that asked or the integration. */
function CredentialsNeeded({ needs }: { needs: HomeCredentialNeed[] }) {
  if (needs.length === 0) return null
  return (
    <div className="home-alerts">
      {needs.slice(0, PROBLEM_LIMIT).map(need => (
        <a
          className="home-alert"
          key={need.id}
          href={need.sessionId ? `#/session/${need.sessionId}` : `#/integration/${need.id}`}
        >
          <span className="chip chip-draft">{T`credentials`}</span>
          <span className="grow">
            <b>{localizeData(need.name)}</b> {T`needs`} {need.missing.map(n => <code key={n}>{n}</code>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
          </span>
          <span className="home-alert-action">{need.sessionId ? T`Open the session` : T`Set credentials`}</span>
        </a>
      ))}
    </div>
  )
}

/** Data-quality alerts: flagged latest runs and overdue integrations, one line each. */
function QualityIssues({ issues }: { issues: HomeQualityIssue[] }) {
  if (issues.length === 0) return null
  return (
    <div className="home-alerts">
      {issues.slice(0, PROBLEM_LIMIT).map(issue => (
        <a className="home-alert attention" key={issue.id} href={`#/integration/${issue.id}`}>
          <span className="chip chip-paused">{issue.kind === "stale" ? T`overdue` : T`flagged`}</span>
          <span className="grow">
            <b>{localizeData(issue.name)}</b>{" "}
            {issue.kind === "stale"
              ? issue.lastSuccessAt
                ? T`last loaded data ${since(issue.lastSuccessAt) ?? ""}, later than expected`
                : T`has never loaded data`
              : issue.messages.join("; ")}
          </span>
          <span className="home-alert-action">{T`Look at the runs`}</span>
        </a>
      ))}
    </div>
  )
}

/** Welcome state: no data has landed yet. */
function Welcome({ home, canDesign }: { home: HomeSummary; canDesign: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const waiting = home.counts.integrations > 0

  async function design() {
    setError(null)
    if (!(await ensureAiAck())) return
    setBusy(true)
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
      <h1>{waiting ? T`No data yet` : T`Let's get some data in`}</h1>
      <p className="home-lede">
        {waiting
          ? T`${plural(home.counts.integrations, T`integration`, T`integrations`)} set up, but nothing has landed yet. Data appears here after a run finishes.`
          : T`Nothing has been ingested yet. Data arrives through integrations: small pipelines that fetch from a source and keep it current on a schedule.`}
      </p>
      {error && <div className="error">{error}</div>}

      {waiting ? (
        <Panel title={T`Your integrations`} link={T`Manage`} href="#/integrations">
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
              title={T`Describe what you need`}
              description={T`Say where the data lives. The agent writes the pipeline, tests it, and shows you the result before anything is saved.`}
              fact={T`Works for any source`}
            />
          )}
          {canLibrary && (
            <LinkCard
              href="#/library"
              icon="library"
              title={T`Start from a ready-made one`}
              description={T`Common sources are already written and tested: rainfall, population, river discharge, elevation.`}
              fact={T`${plural(home.counts.library ?? 0, T`source`, T`sources`)} ready to install`}
            />
          )}
          {!canAgent && !canLibrary && (
            <p className="dim">
              {canDesign
                ? T`No model is configured and this server has no library, so integrations have to be installed with the CLI.`
                : T`Ask an editor or administrator to add an integration.`}
            </p>
          )}
        </div>
      )}

      <div className="home-after">
        <FlowDiagram />
        {T`Once data is in, you can chart it, map it, or ask questions about it.`}
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
    setError(null)
    if (!(await ensureAiAck())) return
    setBusy(true)
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
        <h1>{home.title}</h1>
        <p>
          {T`${(
            <Count n={counts.integrations} one={T`integration`} many={T`integrations`} />
          )} keeping ${(
            <Count n={sources} one={T`data source`} many={T`data sources`} />
          )} current`}
          {" · "}
          <a href="#/how-it-works">{T`How it works`}</a>
        </p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="home-actions">
        {home.ai.assistant && (
          <LinkCard
            href="#/explore"
            icon="ask"
            title={T`Ask a question`}
            description={T`Plain-language questions answered from your data, with the query it ran shown. Your questions are saved under Explore.`}
            fact={T`Reads all ${plural(sources, T`data source`, T`data sources`)}`}
          />
        )}
        {counts.dashboards > 0 ? (
          // Existing dashboards: the card leads to the list (which carries the
          // New Dashboard button); the build card is for the empty state only
          <LinkCard
            href="#/dashboards"
            icon="chart"
            title={T`View dashboards`}
            description={T`Charts, tables and maps built from your data.`}
            fact={plural(counts.dashboards, T`dashboard`, T`dashboards`)}
          />
        ) : canBuildDashboard ? (
          <ActionCard
            onClick={() => void newDashboard()}
            busy={busy}
            icon="chart"
            title={T`Build a dashboard`}
            description={T`Charts, tables and maps you can come back to.`}
            fact={T`None yet`}
          />
        ) : null}
        <LinkCard
          href="#/data"
          icon="data"
          title={T`Browse the data`}
          description={T`See the tables and layers directly, or open them on the map.`}
          fact={`${plural(counts.tables, T`table`, T`tables`)} · ${plural(counts.rasters, T`raster layer`, T`raster layers`)}`}
        />
      </div>

      <Problems problems={home.problems} />
      <CredentialsNeeded needs={home.credentialsNeeded} />
      <QualityIssues issues={home.quality} />

      <div className="home-columns">
        <Panel title={T`Your data`} link={T`All ${sources} sources`} href="#/data">
          {home.sources.map(source => (
            <SourceRow key={`${source.kind}:${source.id}`} source={source} />
          ))}
        </Panel>
        <Panel title={T`Integrations`} link={T`Manage`} href="#/integrations">
          {home.integrations.map(integration => (
            <IntegrationRow key={integration.id} integration={integration} />
          ))}
        </Panel>
      </div>

      <FlowDiagram variant="compact" />
    </main>
  )
}

/** Routes between the welcome and active states once the summary loads. */
export function Home({ user }: { user: User }) {
  const [home, setHome] = useState<HomeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [retry, setRetry] = useState(0)

  useEffect(() => {
    setError(null)
    getHome().then(setHome, (e: Error) => setError(e.message))
  }, [retry])

  if (error) {
    return (
      <main className="home">
        <LoadState error={error} onRetry={() => setRetry(n => n + 1)} />
      </main>
    )
  }
  if (!home) return <main className="home"><LoadState onRetry={() => setRetry(n => n + 1)} /></main>

  const canDesign = user.role !== "viewer"
  return home.hasData ? <Active home={home} canDesign={canDesign} /> : <Welcome home={home} canDesign={canDesign} />
}

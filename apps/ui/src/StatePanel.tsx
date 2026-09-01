import { useState } from "react"
import { AssistantState, DashboardAgentState, DashboardQuery, DesignerState, SessionDetail } from "./api.js"
import { localizeData } from "./localization.js"

/** Panel tabs. */
type Tab = "definition" | "code" | "status"

/** Label for one panel tab, built per call so a locale change reaches it. */
function tabLabel(tab: Tab): string {
  return { definition: T`definition`, code: T`code`, status: T`status` }[tab]
}

/** Label for one dashboard panel tab, built per call so a locale change reaches it. */
function dashboardTabLabel(tab: "source" | "queries"): string {
  return { source: T`source`, queries: T`queries` }[tab]
}

/** Props for the state panel. */
interface StatePanelProps {
  /** Session whose state is shown */
  detail: SessionDetail
}

/** Right-hand panel: draft definition, code, and run/usage status. */
export function StatePanel({ detail }: StatePanelProps) {
  const [tab, setTab] = useState<Tab>("definition")
  if (detail.kind === "dashboard") return <DashboardStatePanel state={detail.state as DashboardAgentState} />
  if (detail.kind === "assistant") return <AssistantStatePanel detail={detail} />
  const state = detail.state as DesignerState
  const { definition } = state
  const { code, ...rest } = definition

  return (
    <aside className="state-panel">
      <div className="tabs">
        {(["definition", "code", "status"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {tabLabel(t)}
          </button>
        ))}
      </div>
      {tab === "definition" && <pre className="pane">{JSON.stringify(rest, null, 2)}</pre>}
      {tab === "code" && <pre className="pane pane-code">{code || T`(no code yet)`}</pre>}
      {tab === "status" && (
        <div className="pane status-pane">
          <dl>
            <dt>{T`Status`}</dt>
            <dd>{detail.status}</dd>
            <dt>{T`Certified`}</dt>
            <dd>{detail.certified ? T`yes (cold run ${state.coldRun?.runId.slice(0, 8)})` : T`no`}</dd>
            <dt>{T`Last run`}</dt>
            <dd>
              {state.lastRun
                ? state.lastRun.cold
                  ? T`cold ${state.lastRun.status}`
                  : T`warm ${state.lastRun.status}`
                : T`none`}
            </dd>
            {detail.scratchLayers.length > 0 && (
              <>
                <dt>{T`Preview layers`}</dt>
                <dd>
                  {detail.scratchLayers.map(layer => (
                    <div key={layer.id}>
                      <a href={`#/layer/${layer.id}?session=${detail.id}`}>{localizeData(layer.name)}</a>
                    </div>
                  ))}
                </dd>
              </>
            )}
            <dt>{T`Model calls`}</dt>
            <dd>{detail.usage?.steps ?? 0}</dd>
            <dt>{T`Tokens`}</dt>
            <dd>
              {detail.usage ? T`${detail.usage.inputTokens.toLocaleString()} in / ${detail.usage.outputTokens.toLocaleString()} out` : "0"}
            </dd>
          </dl>
        </div>
      )}
    </aside>
  )
}

/** Assistant drawer: session status and usage. */
function AssistantStatePanel({ detail }: StatePanelProps) {
  const state = detail.state as AssistantState
  return (
    <aside className="state-panel">
      <div className="pane status-pane">
        <dl>
          <dt>{T`Status`}</dt>
          <dd>{detail.status}</dd>
          <dt>{T`Query results`}</dt>
          <dd>{Object.keys(state?.results ?? {}).length}</dd>
          <dt>{T`Model calls`}</dt>
          <dd>{detail.usage?.steps ?? 0}</dd>
          <dt>{T`Tokens`}</dt>
          <dd>
            {detail.usage
              ? T`${detail.usage.inputTokens.toLocaleString()} in / ${detail.usage.outputTokens.toLocaleString()} out`
              : "0"}
          </dd>
        </dl>
      </div>
    </aside>
  )
}

/** Props for the dashboard variant of the panel. */
interface DashboardStatePanelProps {
  /** Dashboard session state */
  state: DashboardAgentState
}

/** Dashboard drawer: draft source and stored queries. */
function DashboardStatePanel({ state }: DashboardStatePanelProps) {
  const [tab, setTab] = useState<"source" | "queries">("source")
  return (
    <aside className="state-panel">
      <div className="tabs">
        {(["source", "queries"] as const).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {dashboardTabLabel(t)}
          </button>
        ))}
      </div>
      {tab === "source" ? (
        <pre className="pane pane-code">{state.source || T`(no source yet)`}</pre>
      ) : (
        <div className="pane query-list">
          {state.queries.length === 0 ? (
            <p className="dim">{T`(no queries yet)`}</p>
          ) : (
            state.queries.map(query => <QueryCard key={query.name} query={query} />)
          )}
        </div>
      )}
    </aside>
  )
}

/** Props for one stored-query card. */
interface QueryCardProps {
  /** Query to render */
  query: DashboardQuery
}

/** One stored query: name, kind, parameters, and its SQL. */
function QueryCard({ query }: QueryCardProps) {
  return (
    <div className="query-card">
      <div className="query-head">
        <b>{query.name}</b>
        {query.tile && <span className="chip">{T`tiles`}</span>}
        {query.maxRows != null && <span className="chip">{T`max ${query.maxRows.toLocaleString()} rows`}</span>}
      </div>
      {query.params.length > 0 && (
        <div className="query-params">
          {query.params.map((param, i) => (
            // $1..$n bind in declaration order, so the position is what the SQL references
            <span key={param.name} className="query-param">
              <code>${i + 1}</code> {param.name}
              <span className="dim"> {param.required ? T`${param.type} · required` : param.type}</span>
            </span>
          ))}
        </div>
      )}
      <pre className="query-sql">{query.sql}</pre>
    </div>
  )
}

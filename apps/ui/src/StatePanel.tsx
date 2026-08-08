import { useState } from "react"
import { DashboardAgentState, DesignerState, SessionDetail } from "./api.js"

/** Panel tabs. */
type Tab = "definition" | "code" | "status"

/** Props for the state panel. */
interface StatePanelProps {
  /** Session whose state is shown */
  detail: SessionDetail
}

/** Right-hand panel: draft definition, code, and run/usage status. */
export function StatePanel({ detail }: StatePanelProps) {
  const [tab, setTab] = useState<Tab>("definition")
  if (detail.kind === "dashboard") return <DashboardStatePanel state={detail.state as DashboardAgentState} />
  const state = detail.state as DesignerState
  const { definition } = state
  const { code, ...rest } = definition

  return (
    <aside className="state-panel">
      <div className="tabs">
        {(["definition", "code", "status"] as Tab[]).map(t => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "definition" && <pre className="pane">{JSON.stringify(rest, null, 2)}</pre>}
      {tab === "code" && <pre className="pane pane-code">{code || "(no code yet)"}</pre>}
      {tab === "status" && (
        <div className="pane status-pane">
          <dl>
            <dt>Status</dt>
            <dd>{detail.status}</dd>
            <dt>Certified</dt>
            <dd>{detail.certified ? `yes (cold run ${state.coldRun?.runId.slice(0, 8)})` : "no"}</dd>
            <dt>Last run</dt>
            <dd>
              {state.lastRun
                ? `${state.lastRun.cold ? "cold" : "warm"} ${state.lastRun.status}`
                : "none"}
            </dd>
            {detail.scratchLayers.length > 0 && (
              <>
                <dt>Preview layers</dt>
                <dd>
                  {detail.scratchLayers.map(layer => (
                    <div key={layer.id}>
                      <a href={`#/map/${layer.id}?session=${detail.id}`}>{layer.name}</a>
                    </div>
                  ))}
                </dd>
              </>
            )}
            <dt>Model calls</dt>
            <dd>{detail.usage?.steps ?? 0}</dd>
            <dt>Tokens</dt>
            <dd>
              {detail.usage ? `${detail.usage.inputTokens.toLocaleString()} in / ${detail.usage.outputTokens.toLocaleString()} out` : "0"}
            </dd>
          </dl>
        </div>
      )}
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
            {t}
          </button>
        ))}
      </div>
      {tab === "source" ? (
        <pre className="pane pane-code">{state.source || "(no source yet)"}</pre>
      ) : (
        <pre className="pane">{state.queries.length === 0 ? "(no queries yet)" : JSON.stringify(state.queries, null, 2)}</pre>
      )}
    </aside>
  )
}

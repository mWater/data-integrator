import { useState } from "react"
import { SessionDetail } from "./api.js"

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
  const { definition } = detail.state
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
            <dd>{detail.certified ? `yes (cold run ${detail.state.coldRun?.runId.slice(0, 8)})` : "no"}</dd>
            <dt>Last run</dt>
            <dd>
              {detail.state.lastRun
                ? `${detail.state.lastRun.cold ? "cold" : "warm"} ${detail.state.lastRun.status}`
                : "none"}
            </dd>
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

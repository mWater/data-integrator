/** Full-page dashboard viewer. */

import { useEffect, useState } from "react"
import { DashboardDetail, getDashboard } from "./api.js"
import { DashboardFrame } from "./DashboardFrame.js"

/** Props for the dashboard viewer. */
interface Props {
  /** Dashboard id from the route */
  dashboardId: string
}

/** Renders a saved dashboard in its sandboxed frame. */
export function DashboardView({ dashboardId }: Props) {
  const [detail, setDetail] = useState<DashboardDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDashboard(dashboardId).then(setDetail, (e: Error) => setError(e.message))
  }, [dashboardId])

  if (error) return <main className="list-page"><p className="error">{error}</p></main>
  if (!detail) return null

  return (
    <main className="dashboard-page">
      <DashboardFrame
        dashboardId={detail.id}
        bundleJs={detail.bundleJs}
        bundleCss={detail.bundleCss}
      />
    </main>
  )
}

/**
 * Frame-side bootstrap. The compiled dashboard bundle ends with
 * `mountDashboard(Dashboard)`: this connects the bridge, waits for the host
 * handshake, renders the root component, and reports uncaught errors.
 */

import { Component, StrictMode, useState, type ComponentType, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { bridgeError, bridgeState, connectBridge, frameInit, type FrameInit } from "./bridge.js"
import { FrameContext } from "./hooks.js"
import type { ThemeTokens } from "./theme.js"

/** Props supplied by the kit shell when mounting the dashboard. */
export interface DashboardProps {
  /** BCP 47 locale for number/date formatting and kit strings. */
  locale: string
  /** Resolved theme tokens (deployment branding). */
  theme: ThemeTokens
  /** Filter/UI state restored from the host URL, if any; shape is dashboard-defined. */
  initialState?: unknown
  /** Reports state changes so the host can persist them for deep links. */
  onStateChange?: (state: unknown) => void
}

interface ShellProps {
  /** The dashboard root component (the source file's default export). */
  Dashboard: ComponentType<DashboardProps>
  /** Completed host handshake. */
  init: FrameInit
}

function Shell({ Dashboard, init }: ShellProps) {
  const [crashed, setCrashed] = useState<string | null>(null)
  if (crashed) {
    return <div className="p-6 text-sm" role="alert">Dashboard failed to render: {crashed}</div>
  }
  return (
    <FrameContext.Provider value={init}>
      <ErrorBoundary onError={(msg) => setCrashed(msg)}>
        <Dashboard
          locale={init.locale}
          theme={init.theme}
          initialState={init.initialState}
          onStateChange={bridgeState}
        />
      </ErrorBoundary>
    </FrameContext.Provider>
  )
}

interface BoundaryProps {
  /** Notified with the error message when a descendant throws during render. */
  onError: (message: string) => void
  /** Subtree to guard. */
  children: ReactNode
}

class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    bridgeError(error.message, error.stack)
    this.props.onError(error.message)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Mounts the dashboard root component; the compiled bundle calls this once. */
export function mountDashboard(Dashboard: ComponentType<DashboardProps>): void {
  window.addEventListener("error", (e) => {
    // Browsers emit this when layout settles over more than one frame, which
    // charts do on every resize; it is not an error in the dashboard
    if (e.message.startsWith("ResizeObserver loop")) return
    bridgeError(e.message, e.error?.stack)
  })
  window.addEventListener("unhandledrejection", (e) =>
    bridgeError(e.reason instanceof Error ? e.reason.message : String(e.reason), e.reason?.stack)
  )
  connectBridge()
  void frameInit.then((init) => {
    document.documentElement.style.colorScheme = init.theme.mode
    document.body.style.background = init.theme.page
    document.body.style.fontFamily = init.theme.fontFamily
    document.body.style.color = init.theme.inkPrimary
    const el = document.getElementById("root")
    if (!el) throw new Error("frame document missing #root")
    createRoot(el).render(
      <StrictMode>
        <Shell Dashboard={Dashboard} init={init} />
      </StrictMode>
    )
  })
}

/**
 * KitTheme: host-side theme provider, letting kit components (Chart, EChart,
 * DataTable) render outside a dashboard frame. Supplies a synthesized frame
 * init with no meta or layers; useQuery stays frame-only.
 */

import { useMemo, type ReactNode } from "react"
import { FrameContext } from "./hooks.js"
import type { ThemeTokens } from "./theme.js"

/** Props for the host-side theme provider. */
export interface KitThemeProps {
  /** Resolved theme tokens (the host maps its color mode to lightTheme/darkTheme). */
  theme: ThemeTokens
  /** BCP 47 locale; defaults to "en". */
  locale?: string
  /** Content rendered with kit theming available. */
  children: ReactNode
}

/** Provides kit theming to host-rendered components. */
export function KitTheme({ theme, locale = "en", children }: KitThemeProps) {
  const init = useMemo(() => ({ locale, theme, meta: { tables: {} }, layers: [] }), [theme, locale])
  return <FrameContext.Provider value={init}>{children}</FrameContext.Provider>
}

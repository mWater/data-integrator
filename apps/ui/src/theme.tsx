/**
 * App color mode: a three-way preference (light / dark / system) persisted
 * per-device, resolved to a concrete mode, and stamped as data-theme on <html>
 * for styles.css. Dashboard frames read the resolved mode via useAppTheme.
 */

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react"

/** User-facing theme preference; "system" follows the OS setting. */
export type ThemePreference = "light" | "dark" | "system"

/** Concrete mode after resolving "system". */
export type ResolvedMode = "light" | "dark"

/** localStorage key; absent means "system". */
const STORAGE_KEY = "di-theme"

/** Theme state and setter exposed through context. */
interface ThemeContextValue {
  /** Stored preference, including "system". */
  preference: ThemePreference
  /** Preference resolved against the OS setting. */
  mode: ResolvedMode
  /** Persists and applies a new preference. */
  setPreference(preference: ThemePreference): void
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  mode: "light",
  setPreference: () => {}
})

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

/** Provides theme state to the app and keeps <html data-theme> in sync. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  )

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const mode: ResolvedMode = preference === "system" ? (systemDark ? "dark" : "light") : preference

  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      mode,
      setPreference(next) {
        setPreferenceState(next)
        try {
          if (next === "system") localStorage.removeItem(STORAGE_KEY)
          else localStorage.setItem(STORAGE_KEY, next)
        } catch {
          // Private-mode storage failures degrade to session-only preference
        }
      }
    }),
    [preference, mode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Current theme preference, resolved mode, and setter. */
export function useAppTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

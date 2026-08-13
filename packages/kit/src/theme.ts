/**
 * Theme tokens: the brandable color and typography surface for dashboards.
 * Defaults are a validated, brand-neutral palette (categorical order is the
 * CVD-safety mechanism: assign slots in order, never cycle or re-sort).
 *
 * ThemeTokens is read by stored dashboard source, so the interface is
 * append-only: add tokens freely; renaming or removing one breaks saved
 * dashboards.
 */

/** Status colors, reserved for state (never used as series colors). */
export interface StatusColors {
  /** Healthy / on-track. */
  good: string
  /** Needs attention. */
  warning: string
  /** Degraded. */
  serious: string
  /** Failing / breached threshold. */
  critical: string
}

/** Diverging scale endpoints around a neutral midpoint (polarity encoding). */
export interface DivergingPair {
  /** Negative-pole hue (cool). */
  negative: string
  /** Neutral midpoint (gray, never a hue). */
  midpoint: string
  /** Positive-pole hue (warm). */
  positive: string
}

/** Resolved theme tokens for one color mode, as passed to dashboard code. */
export interface ThemeTokens {
  /** Color mode these tokens are resolved for. */
  mode: "light" | "dark"
  /** Categorical series colors in fixed assignment order; slot N always keeps its hue. */
  series: string[]
  /** Single-hue sequential ramp, light to dark, for magnitude encoding. */
  sequential: string[]
  /** Diverging scale for polarity encoding. */
  diverging: DivergingPair
  /** Reserved status colors; ship with icon + label, never color alone. */
  status: StatusColors
  /** Chart / card surface color. */
  surface: string
  /** Page background behind cards. */
  page: string
  /** Primary text ink. */
  inkPrimary: string
  /** Secondary text ink. */
  inkSecondary: string
  /** Muted ink for axis labels and captions. */
  inkMuted: string
  /** Hairline gridline color. */
  gridline: string
  /** Axis baseline color. */
  baseline: string
  /** Hairline border ring for cards and controls. */
  border: string
  /** UI sans stack used everywhere, including hero numbers. */
  fontFamily: string
}

/** Default light-mode tokens (reference palette). */
export const lightTheme: ThemeTokens = {
  mode: "light",
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  sequential: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  diverging: { negative: "#2a78d6", midpoint: "#f0efec", positive: "#e34948" },
  status: { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" },
  surface: "#fcfcfb",
  page: "#f9f9f7",
  inkPrimary: "#0b0b0b",
  inkSecondary: "#52514e",
  inkMuted: "#898781",
  gridline: "#e1e0d9",
  baseline: "#c3c2b7",
  border: "rgba(11,11,11,0.10)",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
}

/** Default dark-mode tokens: same hues re-stepped for the dark surface, validated as a set. */
export const darkTheme: ThemeTokens = {
  mode: "dark",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  sequential: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  diverging: { negative: "#3987e5", midpoint: "#383835", positive: "#e66767" },
  status: { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" },
  surface: "#1a1a19",
  page: "#0d0d0d",
  inkPrimary: "#ffffff",
  inkSecondary: "#c3c2b7",
  inkMuted: "#898781",
  gridline: "#2c2c2a",
  baseline: "#383835",
  border: "rgba(255,255,255,0.10)",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
}

/**
 * Series color for a zero-based slot index. Past the validated slots, callers
 * should fold categories into "Other" rather than invent hues; this clamps to
 * the last slot as a backstop, never generates colors.
 */
export function seriesColor(theme: ThemeTokens, index: number): string {
  return theme.series[Math.min(index, theme.series.length - 1)]
}

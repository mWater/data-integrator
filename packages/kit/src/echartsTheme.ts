/**
 * ECharts init-theme derived from ThemeTokens, for the EChart escape hatch.
 * Registering it at init time makes ECharts merge the author's raw option on
 * top, so palette, ink, fonts, and axis chrome stay on-theme underneath.
 */

import type { ThemeTokens } from "./theme.js"

/** One axis type's themed chrome (baseline, labels, gridlines). */
function axisTheme(theme: ThemeTokens, text: object) {
  return {
    axisLine: { lineStyle: { color: theme.baseline } },
    axisTick: { show: false },
    axisLabel: text,
    splitLine: { lineStyle: { color: theme.gridline, width: 1 } }
  }
}

/** Builds the ECharts theme object for one resolved token set. */
export function echartsTheme(theme: ThemeTokens): object {
  const text = { color: theme.inkSecondary, fontFamily: theme.fontFamily, fontSize: 11 }
  return {
    color: theme.series,
    backgroundColor: "transparent",
    textStyle: { color: theme.inkSecondary, fontFamily: theme.fontFamily },
    categoryAxis: axisTheme(theme, text),
    valueAxis: axisTheme(theme, text),
    timeAxis: axisTheme(theme, text),
    legend: { textStyle: text },
    tooltip: { textStyle: { fontFamily: theme.fontFamily } },
    dataZoom: { borderColor: theme.border, textStyle: { ...text, fontSize: 10 } },
    visualMap: { textStyle: text }
  }
}

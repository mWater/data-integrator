/**
 * EChart: the sanctioned escape hatch for chart forms the declarative Chart
 * cannot express. Takes a raw ECharts option and applies it over the theme
 * (palette, ink, fonts, axis chrome merged underneath via an init theme).
 * The registered module set is curated, not all of ECharts. Saved dashboards
 * depend on it: the ECharts major and this module list are compatibility
 * surface, extended freely but never trimmed within a kit version.
 */

import { useEffect, useRef } from "react"
import { use, init, type EChartsType, type EChartsCoreOption } from "echarts/core"
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts"
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent
} from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import { useTheme } from "../hooks.js"
import { echartsTheme } from "../echartsTheme.js"

use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
])

/** Props for the EChart escape hatch. */
export interface EChartProps {
  /** Raw ECharts option, applied over the theme. */
  option: EChartsCoreOption
  /** Accessible description of the chart (its aria-label). */
  label?: string
  /** Pixel height of the plot. */
  height?: number
}

/** Renders a raw ECharts option with the theme merged underneath. */
export function EChart({ option, label, height }: EChartProps) {
  const theme = useTheme()
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | null>(null)

  // The theme is an init-time argument, so a mode switch re-creates the instance
  useEffect(() => {
    if (!el.current) return
    const instance = init(el.current, echartsTheme(theme))
    chart.current = instance
    const ro = new ResizeObserver(() => instance.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [theme])

  useEffect(() => {
    chart.current?.setOption(option, true)
  })

  return <div ref={el} style={{ height: height ?? 260 }} role="img" aria-label={label ?? "chart"} />
}

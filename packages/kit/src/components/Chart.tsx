/**
 * Chart: the single chart surface, wrapping ECharts. One value axis by design
 * (dual-axis charts are a method violation: use two charts or index the data).
 * Categorical colors come from the theme slots in fixed order, never cycled.
 */

import { useEffect, useRef } from "react"
import { use, init, type EChartsType, type EChartsCoreOption } from "echarts/core"
import { BarChart, LineChart, PieChart } from "echarts/charts"
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { Row } from "../bridge.js"
import { useTheme } from "../hooks.js"
import { seriesColor, type ThemeTokens } from "../theme.js"

use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

/** Props for the Chart component. */
export interface ChartProps {
  /** Chart form. Pick by the data's job: change-over-time = line/area, magnitude comparison = bar, part-of-whole = pie (few slices). */
  type: "line" | "area" | "bar" | "pie"
  /** Result rows, one per x value (or one per slice for pie). */
  data: Row[]
  /** Column holding the x category (or the slice label for pie). */
  x: string
  /** Columns plotted as series, in fixed color-slot order. Pie takes exactly one value column. */
  series: string[]
  /** Display labels per series column; defaults to the column name. */
  labels?: Record<string, string>
  /** Stacks bar/area series when true. */
  stacked?: boolean
  /** Pixel height of the plot. */
  height?: number
  /** Formats values for tooltips and the value axis. */
  format?: (value: number) => string
}

function buildOption(props: ChartProps, theme: ThemeTokens): EChartsCoreOption {
  const { type, data, x, series, labels, stacked, format } = props
  const text = { color: theme.inkSecondary, fontFamily: theme.fontFamily, fontSize: 11 }
  const fmt = format ?? ((v: number) => String(v))
  const axisFmt = (v: number | string) => (typeof v === "number" ? fmt(v) : String(v))

  if (type === "pie") {
    const value = series[0]
    return {
      color: data.map((_, i) => seriesColor(theme, i)),
      tooltip: { trigger: "item", valueFormatter: fmt },
      legend: { bottom: 0, textStyle: text, icon: "circle" },
      series: [
        {
          type: "pie",
          radius: ["45%", "72%"],
          top: 0,
          bottom: 24,
          itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
          label: { color: theme.inkSecondary, fontFamily: theme.fontFamily, fontSize: 11 },
          data: data.map((row) => ({ name: String(row[x]), value: row[value] as number }))
        }
      ]
    }
  }

  return {
    color: series.map((_, i) => seriesColor(theme, i)),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: type === "bar" ? "shadow" : "line" },
      valueFormatter: fmt
    },
    // A single series needs no legend box: the card title names it
    legend:
      series.length > 1 ? { bottom: 0, textStyle: text, icon: "circle" } : { show: false },
    grid: { left: 8, right: 12, top: 12, bottom: series.length > 1 ? 32 : 8, containLabel: true },
    xAxis: {
      type: "category",
      data: data.map((row) => String(row[x])),
      axisLine: { lineStyle: { color: theme.baseline } },
      axisTick: { show: false },
      axisLabel: text
    },
    yAxis: {
      type: "value",
      axisLabel: { ...text, formatter: axisFmt },
      splitLine: { lineStyle: { color: theme.gridline, width: 1 } }
    },
    series: series.map((col) => {
      const name = labels?.[col] ?? col
      const values = data.map((row) => row[col] as number)
      if (type === "bar") {
        return {
          name,
          type: "bar",
          stack: stacked ? "total" : undefined,
          data: values,
          // Rounded data-end anchored to the baseline; surface gap between stacked fills
          itemStyle: stacked
            ? { borderColor: theme.surface, borderWidth: 1 }
            : { borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 40
        }
      }
      return {
        name,
        type: "line",
        stack: type === "area" && stacked ? "total" : undefined,
        areaStyle: type === "area" ? { opacity: 0.25 } : undefined,
        data: values,
        lineStyle: { width: 2 },
        showSymbol: false,
        symbolSize: 8,
        emphasis: { focus: series.length > 1 ? "series" : "none" }
      }
    })
  }
}

/** Renders one chart; resizes with its container and re-renders on data/theme change. */
export function Chart(props: ChartProps) {
  const theme = useTheme()
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | null>(null)

  useEffect(() => {
    if (!el.current) return
    const instance = init(el.current)
    chart.current = instance
    const ro = new ResizeObserver(() => instance.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(buildOption(props, theme), true)
  })

  return <div ref={el} style={{ height: props.height ?? 260 }} role="img" />
}

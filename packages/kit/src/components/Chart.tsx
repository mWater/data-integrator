/**
 * Chart: the single chart surface, wrapping ECharts. One value axis by design
 * (dual-axis charts are a method violation: use two charts or index the data).
 * Categorical colors come from the theme slots in fixed order, never cycled.
 */

import { useEffect, useRef } from "react"
import { use, init, type EChartsType, type EChartsCoreOption } from "echarts/core"
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts"
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { Row } from "../bridge.js"
import { useTheme } from "../hooks.js"
import { seriesColor, type ThemeTokens } from "../theme.js"

use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer
])

/** Props for the Chart component. */
export interface ChartProps {
  /** Chart form. Pick by the data's job: change-over-time = line/area, magnitude comparison = bar, part-of-whole = pie (few slices), relation between two measures = scatter. */
  type: "line" | "area" | "bar" | "pie" | "scatter"
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
  /** X-axis scale: "category" (default) or "time" (a true time axis; x values are ISO date/timestamp strings). Scatter defaults to a numeric x axis. */
  xType?: "category" | "time"
  /** Interactive zoom (wheel/drag plus a range slider) for long series. */
  zoom?: boolean
  /** Accessible description of the chart (its aria-label); defaults to the series display labels. */
  label?: string
}

/** Accessible name for the chart: the explicit label, else the series display labels. Exported for tests. */
export function chartLabel(props: ChartProps): string {
  return props.label ?? props.series.map((col) => props.labels?.[col] ?? col).join(", ")
}

/** Builds the full ECharts option for the given props and theme. Exported for tests. */
export function buildOption(props: ChartProps, theme: ThemeTokens): EChartsCoreOption {
  const { type, data, x, series, labels, stacked, format, xType, zoom } = props
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

  // Scatter relates two measures, so its x defaults to a value axis
  const axisType: "category" | "time" | "value" = xType ?? (type === "scatter" ? "value" : "category")
  // Non-category axes carry the x value inside each datum instead of xAxis.data
  const seriesData = (col: string) =>
    axisType === "category" ? data.map((row) => row[col] as number) : data.map((row) => [row[x], row[col] as number])

  const showLegend = series.length > 1
  return {
    color: series.map((_, i) => seriesColor(theme, i)),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: type === "bar" ? "shadow" : type === "scatter" ? "cross" : "line" },
      valueFormatter: fmt
    },
    // A single series needs no legend box: the card title names it.
    // The zoom slider owns the bottom edge, so the legend moves up top.
    legend: showLegend
      ? zoom
        ? { top: 0, textStyle: text, icon: "circle" }
        : { bottom: 0, textStyle: text, icon: "circle" }
      : { show: false },
    grid: {
      left: 8,
      right: 12,
      top: zoom && showLegend ? 32 : 12,
      bottom: zoom ? 40 : showLegend ? 32 : 8,
      containLabel: true
    },
    ...(zoom
      ? {
          dataZoom: [
            { type: "inside" },
            { type: "slider", bottom: 0, height: 18, borderColor: theme.border, textStyle: { ...text, fontSize: 10 } }
          ]
        }
      : {}),
    xAxis: {
      type: axisType,
      ...(axisType === "category" ? { data: data.map((row) => String(row[x])) } : {}),
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
      if (type === "bar") {
        return {
          name,
          type: "bar",
          stack: stacked ? "total" : undefined,
          data: seriesData(col),
          // Rounded data-end anchored to the baseline; surface gap between stacked fills
          itemStyle: stacked
            ? { borderColor: theme.surface, borderWidth: 1 }
            : { borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 40
        }
      }
      if (type === "scatter") {
        return {
          name,
          type: "scatter",
          data: seriesData(col),
          symbolSize: 8,
          emphasis: { focus: series.length > 1 ? "series" : "none" }
        }
      }
      return {
        name,
        type: "line",
        stack: type === "area" && stacked ? "total" : undefined,
        areaStyle: type === "area" ? { opacity: 0.25 } : undefined,
        data: seriesData(col),
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

  return <div ref={el} style={{ height: props.height ?? 260 }} role="img" aria-label={chartLabel(props)} />
}

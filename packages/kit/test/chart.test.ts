/** Unit tests for the Chart option builder and the EChart init theme. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { buildOption, chartLabel, type ChartProps } from "../src/components/Chart.js"
import { echartsTheme } from "../src/echartsTheme.js"
import { lightTheme } from "../src/theme.js"

const rows = [
  { month: "2026-01-01", rain: 12, level: 3.1 },
  { month: "2026-02-01", rain: 30, level: 2.8 },
  { month: "2026-03-01", rain: 55, level: 2.2 }
]

function opt(overrides: Partial<ChartProps>) {
  return buildOption(
    { type: "line", data: rows, x: "month", series: ["rain"], ...overrides },
    lightTheme
  ) as any
}

test("category axis keeps the original shape", () => {
  const o = opt({ type: "bar", series: ["rain", "level"] })
  assert.equal(o.xAxis.type, "category")
  assert.deepEqual(o.xAxis.data, ["2026-01-01", "2026-02-01", "2026-03-01"])
  assert.deepEqual(o.series[0].data, [12, 30, 55])
  assert.equal(o.legend.bottom, 0)
  assert.equal(o.dataZoom, undefined)
})

test("xType time drops xAxis.data and pairs the series data", () => {
  const o = opt({ xType: "time" })
  assert.equal(o.xAxis.type, "time")
  assert.equal(o.xAxis.data, undefined)
  assert.deepEqual(o.series[0].data[1], ["2026-02-01", 30])
})

test("scatter defaults to a value x axis with scatter series", () => {
  const o = opt({ type: "scatter", x: "rain", series: ["level"] })
  assert.equal(o.xAxis.type, "value")
  assert.equal(o.series[0].type, "scatter")
  assert.deepEqual(o.series[0].data[0], [12, 3.1])
})

test("zoom adds dataZoom and moves a shown legend to the top", () => {
  const o = opt({ zoom: true, series: ["rain", "level"] })
  assert.equal(o.dataZoom.length, 2)
  assert.equal(o.dataZoom[0].type, "inside")
  assert.equal(o.dataZoom[1].type, "slider")
  assert.equal(o.legend.top, 0)
  assert.equal(o.legend.bottom, undefined)
})

test("pie path is unaffected by the new props", () => {
  const o = opt({ type: "pie", zoom: true, xType: "time" })
  assert.equal(o.series[0].type, "pie")
  assert.equal(o.dataZoom, undefined)
})

test("chartLabel prefers the explicit label, else joins series display labels", () => {
  const base: ChartProps = {
    type: "line",
    data: rows,
    x: "month",
    series: ["rain", "level"],
    labels: { rain: "Rainfall" }
  }
  assert.equal(chartLabel(base), "Rainfall, level")
  assert.equal(chartLabel({ ...base, label: "Rainfall against river level" }), "Rainfall against river level")
})

test("echartsTheme derives its chrome from the tokens", () => {
  const t = echartsTheme(lightTheme) as any
  assert.deepEqual(t.color, lightTheme.series)
  assert.equal(t.backgroundColor, "transparent")
  for (const axis of ["categoryAxis", "valueAxis", "timeAxis"]) {
    assert.equal(t[axis].axisLine.lineStyle.color, lightTheme.baseline)
    assert.equal(t[axis].splitLine.lineStyle.color, lightTheme.gridline)
  }
  assert.equal(t.legend.textStyle.color, lightTheme.inkSecondary)
})

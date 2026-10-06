/** Chart block: a declarative kit Chart bound to a stored query result. */

import { Chart } from "@data-integrator/kit"
import { AssistantResult } from "../api.js"
import { BlockShell } from "./BlockShell.js"
import { ShowChartInput } from "./types.js"

/** Props for a chart block. */
interface ChartBlockProps {
  /** The show_chart tool input (the declarative spec) */
  spec: ShowChartInput
  /** The stored result the spec binds to */
  result: AssistantResult
}

/** Renders one chart block from its spec and result rows. */
export function ChartBlock({ spec, result }: ChartBlockProps) {
  // Belt-and-braces: numeric columns the SQL forgot to cast arrive as strings
  const rows = result.rows.map(row => {
    const out = { ...row }
    for (const col of spec.series) {
      const value = out[col]
      if (typeof value === "string" && value !== "" && !Number.isNaN(Number(value))) out[col] = Number(value)
    }
    return out
  })
  return (
    <BlockShell title={spec.title} sql={result.sql}>
      <Chart
        type={spec.type}
        data={rows}
        x={spec.x}
        series={spec.series}
        labels={spec.labels}
        stacked={spec.stacked}
        xType={spec.xType}
        height={280}
      />
    </BlockShell>
  )
}

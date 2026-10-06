/**
 * Renders one assistant block (table, chart, map) from a tool-call input plus
 * the session's stored results. The lazy boundary for the whole blocks chunk:
 * echarts and maplibre load only when a transcript actually contains blocks.
 */

import { darkTheme, lightTheme } from "@data-integrator/kit/host"
import { KitTheme } from "@data-integrator/kit"
import { AssistantResult } from "../api.js"
import { useAppTheme } from "../theme.js"
import { ChartBlock } from "./ChartBlock.js"
import { MapBlock } from "./MapBlock.js"
import { TableBlock } from "./TableBlock.js"
import { parseResultId, ShowChartInput, ShowMapInput, ShowTableInput } from "./types.js"

/** Props for the block renderer. */
interface BlockRendererProps {
  /** Tool that produced the block: show_table, show_chart, or show_map */
  tool: string
  /** The tool-call input part */
  input: unknown
  /** Tool result text (carries the result id for table blocks) */
  resultText?: string
  /** The session's stored results */
  results: Record<string, AssistantResult> | undefined
}

/** Quiet placeholder when a block's stored result is not available. */
function Unavailable() {
  return <div className="activity">{T`result unavailable`}</div>
}

/** Renders one block by tool, themed for the host's color mode. */
export default function BlockRenderer({ tool, input, resultText, results }: BlockRendererProps) {
  const { mode } = useAppTheme()
  let content = null
  if (tool === "show_table") {
    const id = parseResultId(resultText)
    const result = id ? results?.[id] : undefined
    content =
      id && result ? (
        <TableBlock
          resultId={id}
          result={result}
          title={(input as ShowTableInput).title}
          labels={(input as ShowTableInput).labels}
        />
      ) : (
        <Unavailable />
      )
  } else if (tool === "show_chart") {
    const spec = input as ShowChartInput
    const result = results?.[spec.resultId]
    content = result ? <ChartBlock spec={spec} result={result} /> : <Unavailable />
  } else if (tool === "show_map") {
    const spec = input as ShowMapInput
    const missing = (spec.overlays ?? []).some(o => !results?.[o.resultId])
    content = missing ? <Unavailable /> : <MapBlock spec={spec} results={results ?? {}} />
  }
  return (
    <KitTheme theme={mode === "dark" ? darkTheme : lightTheme} locale={navigator.language}>
      {content}
    </KitTheme>
  )
}

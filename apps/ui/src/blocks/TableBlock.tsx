/** Table block: a query result rendered like the data browser, with CSV download. */

import { DataTable } from "@data-integrator/kit"
import { AssistantResult } from "../api.js"
import { BlockShell } from "./BlockShell.js"
import { downloadCsv } from "./csv.js"

/** Compacts objects (GeoJSON, JSON columns) for table cells. */
function cellText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "object") {
    const text = JSON.stringify(value)
    return text.length > 80 ? text.slice(0, 77) + "…" : text
  }
  return String(value)
}

/** Props for a table block. */
interface TableBlockProps {
  /** Result id, used for the CSV filename */
  resultId: string
  /** The stored result */
  result: AssistantResult
}

/** Renders one query result as a data-browser-style table. */
export function TableBlock({ resultId, result }: TableBlockProps) {
  const columns = result.columns.map(key => ({
    key,
    numeric: typeof result.rows.find(r => r[key] != null)?.[key] === "number",
    format: cellText
  }))
  return (
    <BlockShell
      meta={`${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`}
      sql={result.sql}
      onDownloadCsv={() => downloadCsv(`${resultId}.csv`, result.columns, result.rows)}
    >
      <div className="block-table">
        <DataTable data={result.rows} columns={columns} height={280} />
      </div>
    </BlockShell>
  )
}

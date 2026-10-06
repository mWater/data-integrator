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
  /** Title above the table */
  title?: string
  /** Display header per column id */
  labels?: Record<string, string>
}

/** snake_case column id to a presentable header, when the agent gave no label. */
function prettify(key: string): string {
  const words = key.replace(/_/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Renders one query result as a data-browser-style table. */
export function TableBlock({ resultId, result, title, labels }: TableBlockProps) {
  const columns = result.columns.map(key => ({
    key,
    label: labels?.[key] ?? prettify(key),
    numeric: typeof result.rows.find(r => r[key] != null)?.[key] === "number",
    format: cellText
  }))
  return (
    <BlockShell
      title={title}
      meta={result.rows.length === 1 ? T`${result.rows.length} row` : T`${result.rows.length} rows`}
      sql={result.sql}
      onDownloadCsv={() => downloadCsv(`${resultId}.csv`, result.columns, result.rows)}
    >
      <div className="block-table">
        <DataTable data={result.rows} columns={columns} height={280} />
      </div>
    </BlockShell>
  )
}

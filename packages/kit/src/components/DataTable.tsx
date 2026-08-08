/** Data table: the accessible tabular view for query results. */

import { useTheme } from "../hooks.js"
import type { Row } from "../bridge.js"

/** One column of a data table. */
export interface TableColumn {
  /** Row key to read. */
  key: string
  /** Header label; defaults to the key. */
  label?: string
  /** Right-aligns and uses tabular figures; set for numeric columns. */
  numeric?: boolean
  /** Formats the cell value; defaults to String(). */
  format?: (value: unknown) => string
}

/** Props for the data table. */
export interface DataTableProps {
  /** Result rows to render. */
  data: Row[]
  /** Columns in display order; defaults to the keys of the first row. */
  columns?: TableColumn[]
  /** Accessible description of the table contents. */
  caption?: string
  /** Pixel height of the scroll region; content scrolls inside it. */
  height?: number
}

/** Scrollable table with sticky header; numbers right-aligned in tabular figures. */
export function DataTable({ data, columns, caption, height }: DataTableProps) {
  const theme = useTheme()
  const cols: TableColumn[] =
    columns ??
    Object.keys(data[0] ?? {}).map((key) => ({
      key,
      numeric: typeof data[0]?.[key] === "number"
    }))
  return (
    <div className="overflow-auto" style={{ maxHeight: height ?? 320 }}>
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={"sticky top-0 px-2 py-1.5 text-left text-xs font-medium" + (c.numeric ? " text-right" : "")}
                style={{ background: theme.surface, color: theme.inkSecondary, borderBottom: `1px solid ${theme.baseline}` }}
              >
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={"px-2 py-1.5" + (c.numeric ? " text-right [font-variant-numeric:tabular-nums]" : "")}
                  style={{ borderBottom: `1px solid ${theme.gridline}` }}
                >
                  {c.format ? c.format(row[c.key]) : row[c.key] == null ? "" : String(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

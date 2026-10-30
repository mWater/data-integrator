/**
 * Data table: the accessible tabular view for query results. Styled inline
 * (no stylesheet dependency) so it renders identically inside dashboard
 * frames and host-side under KitTheme.
 */

import type { CSSProperties } from "react"
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

/** Visually-hidden style for the accessible caption. */
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0
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
  const cell: CSSProperties = { padding: "6px 8px" }
  return (
    <div style={{ overflow: "auto", maxHeight: height ?? 320 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, lineHeight: 1.4 }}>
        {caption ? <caption style={srOnly}>{caption}</caption> : null}
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{
                  ...cell,
                  position: "sticky",
                  top: 0,
                  fontSize: 12,
                  fontWeight: 500,
                  textAlign: c.numeric ? "right" : "left",
                  background: theme.surface,
                  color: theme.inkSecondary,
                  borderBottom: `1px solid ${theme.baseline}`
                }}
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
                  style={{
                    ...cell,
                    textAlign: c.numeric ? "right" : "left",
                    fontVariantNumeric: c.numeric ? "tabular-nums" : undefined,
                    borderBottom: `1px solid ${theme.gridline}`
                  }}
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

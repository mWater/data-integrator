/** Stat tile: a single headline number with label and optional status. */

import { useTheme } from "../hooks.js"

/** Props for a stat tile. */
export interface StatTileProps {
  /** Metric label above the value. */
  label: string
  /** Headline value, preformatted by the caller. */
  value: string
  /** Secondary line under the value (period, comparison, unit). */
  detail?: string
  /** Optional status coloring; rendered with a dot + the label, never color alone. */
  status?: "good" | "warning" | "serious" | "critical"
}

/** A single headline number; use instead of a chart when the job is one value. */
export function StatTile({ label, value, detail, status }: StatTileProps) {
  const theme = useTheme()
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: theme.inkSecondary }}>
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
      {detail ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: theme.inkSecondary }}>
          {status ? (
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: theme.status[status] }}
            />
          ) : null}
          <span>{detail}</span>
        </div>
      ) : null}
    </div>
  )
}

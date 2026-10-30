/**
 * Structured editor for the trigger's cron expression. Presents the common
 * shapes (hourly/daily/weekly/monthly) as pickers, decomposes an existing
 * expression back into them when it fits, and falls back to a raw cron
 * field for anything more exotic. All times are UTC, matching the scheduler.
 */
import { useMemo } from "react"
import { cronText } from "./localization.js"

/** Editor modes, from no schedule to the raw escape hatch. */
type CronMode = "manual" | "hourly" | "daily" | "weekly" | "monthly" | "custom"

/** Structured state the editor round-trips with the cron string. */
export interface CronDraft {
  /** Which shape is selected */
  mode: CronMode
  /** Minute 0-59 (hourly mode) */
  minute: string
  /** "HH:MM" UTC (daily/weekly/monthly modes) */
  time: string
  /** Weekday 0-6, Sunday 0 (weekly mode) */
  weekday: string
  /** Day of month 1-31 (monthly mode) */
  monthday: string
  /** Raw expression (custom mode) */
  raw: string
}

/** Decomposes a stored cron into a draft; unrecognized shapes become custom. */
export function toCronDraft(cron: string | null | undefined): CronDraft {
  const draft: CronDraft = { mode: "manual", minute: "0", time: "06:00", weekday: "1", monthday: "1", raw: cron ?? "" }
  if (!cron) return draft
  const m = cron.trim().match(/^(\d{1,2}) (\d{1,2}|\*) (\d{1,2}|\*) \* (\d|\*)$/)
  if (!m) return { ...draft, mode: "custom" }
  const [, minute, hour, dom, dow] = m
  const time = hour === "*" ? "06:00" : `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
  if (hour === "*" && dom === "*" && dow === "*") return { ...draft, mode: "hourly", minute }
  if (hour !== "*" && dom === "*" && dow === "*") return { ...draft, mode: "daily", time }
  if (hour !== "*" && dom === "*" && dow !== "*") return { ...draft, mode: "weekly", time, weekday: dow === "7" ? "0" : dow }
  if (hour !== "*" && dom !== "*" && dow === "*") return { ...draft, mode: "monthly", time, monthday: dom }
  return { ...draft, mode: "custom" }
}

/** Composes the draft back into a cron string; null means no schedule. */
export function fromCronDraft(draft: CronDraft): string | null {
  const [hour, minute] = draft.time.split(":").map(part => String(Number(part)))
  switch (draft.mode) {
    case "manual":
      return null
    case "hourly":
      return `${Number(draft.minute) || 0} * * * *`
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekly":
      return `${minute} ${hour} * * ${Number(draft.weekday) || 0}`
    case "monthly":
      return `${minute} ${hour} ${Number(draft.monthday) || 1} * *`
    case "custom":
      return draft.raw.trim() === "" ? null : draft.raw.trim()
  }
}

/** Props for the cron editor. */
interface CronEditorProps {
  /** Current draft state */
  draft: CronDraft
  /** Replaces the draft on any change */
  onChange: (draft: CronDraft) => void
}

/** Weekday options, Sunday first to match cron numbering. */
function weekdayNames(): string[] {
  return [T`Sunday`, T`Monday`, T`Tuesday`, T`Wednesday`, T`Thursday`, T`Friday`, T`Saturday`]
}

/** The structured schedule editor. */
export function CronEditor({ draft, onChange }: CronEditorProps) {
  const composed = useMemo(() => fromCronDraft(draft), [draft])
  const set = (patch: Partial<CronDraft>) => onChange({ ...draft, ...patch })

  return (
    <div className="cron-editor">
      <div className="cron-row">
        <select value={draft.mode} onChange={e => set({ mode: e.target.value as CronMode })} aria-label={T`Schedule`}>
          <option value="manual">{T`Manual only`}</option>
          <option value="hourly">{T`Hourly`}</option>
          <option value="daily">{T`Daily`}</option>
          <option value="weekly">{T`Weekly`}</option>
          <option value="monthly">{T`Monthly`}</option>
          <option value="custom">{T`Custom (cron)`}</option>
        </select>
        {draft.mode === "hourly" && (
          <label>
            {T`at minute`}{" "}
            <input type="number" min={0} max={59} value={draft.minute} onChange={e => set({ minute: e.target.value })} />
          </label>
        )}
        {draft.mode === "weekly" && (
          <select value={draft.weekday} onChange={e => set({ weekday: e.target.value })} aria-label={T`Day of the week`}>
            {weekdayNames().map((name, day) => (
              <option key={day} value={String(day)}>
                {name}
              </option>
            ))}
          </select>
        )}
        {draft.mode === "monthly" && (
          <label>
            {T`on day`}{" "}
            <input type="number" min={1} max={31} value={draft.monthday} onChange={e => set({ monthday: e.target.value })} />
          </label>
        )}
        {(draft.mode === "daily" || draft.mode === "weekly" || draft.mode === "monthly") && (
          <label>
            {T`at`} <input type="time" value={draft.time} onChange={e => set({ time: e.target.value })} /> UTC
          </label>
        )}
        {draft.mode === "custom" && (
          <input
            type="text"
            style={{ width: 220 }}
            placeholder="0 6 10 * *"
            aria-label={T`Cron expression (UTC)`}
            value={draft.raw}
            onChange={e => set({ raw: e.target.value })}
          />
        )}
      </div>
      {composed && <p className="dim">{cronText(composed)}</p>}
      {draft.mode === "monthly" && Number(draft.monthday) > 28 && (
        <p className="dim">{T`Days past 28 are skipped in shorter months.`}</p>
      )}
    </div>
  )
}

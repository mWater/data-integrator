/**
 * Filter bar and its controls. Controls are plain value/onChange React state:
 * the dashboard passes selected values into query params, and the stored SQL
 * decides what a null/empty selection means.
 */

import type { ReactNode } from "react"
import { useTheme } from "../hooks.js"

/** Props for the filter bar container. */
export interface FilterBarProps {
  /** Filter controls, laid out in one wrapping row. */
  children: ReactNode
}

/** One row of filter controls; place in Page controls or above the grid. */
export function FilterBar({ children }: FilterBarProps) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

/** One option of a select control. */
export interface SelectOption {
  /** Submitted value. */
  value: string
  /** Display label; defaults to the value. */
  label?: string
}

/** Props for the single-select control. */
export interface SelectProps {
  /** Accessible label, rendered beside the control. */
  label: string
  /** Options in display order. */
  options: SelectOption[]
  /** Selected value, or "" for the all/none choice. */
  value: string
  /** Called with the newly selected value. */
  onChange: (value: string) => void
  /** Label of the leading "all" choice; omit to force a concrete selection. */
  allLabel?: string
}

/** Single-select dimension filter. */
export function Select({ label, options, value, onChange, allLabel }: SelectProps) {
  const theme = useTheme()
  return (
    <label className="flex items-center gap-1.5 text-xs" style={{ color: theme.inkSecondary }}>
      {label}
      <select
        className="rounded-md px-2 py-1.5 text-sm"
        style={{ background: theme.surface, color: theme.inkPrimary, border: `1px solid ${theme.border}` }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allLabel != null ? <option value="">{allLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Props for the multi-select control. */
export interface MultiSelectProps {
  /** Accessible label shown on the trigger. */
  label: string
  /** Options in display order. */
  options: SelectOption[]
  /** Selected values; empty means "all" by convention. */
  value: string[]
  /** Called with the new selection. */
  onChange: (value: string[]) => void
}

/** Multi-select dimension filter: a disclosure with checkboxes. */
export function MultiSelect({ label, options, value, onChange }: MultiSelectProps) {
  const theme = useTheme()
  const summary = value.length === 0 ? label : `${label} (${value.length})`
  return (
    <details className="relative text-sm">
      <summary
        className="cursor-pointer select-none rounded-md px-2 py-1.5"
        style={{ background: theme.surface, color: theme.inkPrimary, border: `1px solid ${theme.border}` }}
      >
        {summary}
      </summary>
      <div
        className="absolute z-10 mt-1 max-h-64 min-w-44 overflow-auto rounded-md p-2 shadow-lg"
        style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
      >
        {options.map((o) => {
          const checked = value.includes(o.value)
          return (
            <label key={o.value} className="flex items-center gap-2 px-1 py-1">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(checked ? value.filter((v) => v !== o.value) : [...value, o.value])
                }
              />
              {o.label ?? o.value}
            </label>
          )
        })}
      </div>
    </details>
  )
}

/** Props for the date-range control. */
export interface DateRangeProps {
  /** Accessible label for the pair. */
  label: string
  /** Inclusive start date (YYYY-MM-DD) or "" for open. */
  from: string
  /** Inclusive end date (YYYY-MM-DD) or "" for open. */
  to: string
  /** Called with the new range. */
  onChange: (from: string, to: string) => void
}

/** Date-range filter as a from/to pair of native date inputs. */
export function DateRange({ label, from, to, onChange }: DateRangeProps) {
  const theme = useTheme()
  const inputStyle = {
    background: theme.surface,
    color: theme.inkPrimary,
    border: `1px solid ${theme.border}`
  }
  return (
    <fieldset className="flex items-center gap-1.5 text-xs" style={{ color: theme.inkSecondary }}>
      <legend className="sr-only">{label}</legend>
      {label}
      <input
        type="date"
        aria-label={`${label} from`}
        className="rounded-md px-2 py-1.5 text-sm"
        style={inputStyle}
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
      />
      –
      <input
        type="date"
        aria-label={`${label} to`}
        className="rounded-md px-2 py-1.5 text-sm"
        style={inputStyle}
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
      />
    </fieldset>
  )
}

/**
 * Standard 5-field cron expressions (minute hour day-of-month month
 * day-of-week), evaluated in UTC. Supports *, lists, ranges, and steps;
 * day-of-week accepts 0-7 with both 0 and 7 as Sunday. Vixie semantics for
 * the day fields: when both day-of-month and day-of-week are restricted, a
 * date matches if EITHER does. No dependencies: the parser is also the
 * validator for definition triggers.
 */

/** A parsed cron expression. */
export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /** True when the field was not "*" (drives the vixie either-day rule). */
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

/** [min, max] for each field, in order. */
const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
]

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"]

/** Parses one field into its value set; throws with the field name on errors. */
function parseField(field: string, index: number): Set<number> {
  const [min, max] = FIELD_RANGES[index]
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+?)(?:\/(\d+))?$/)
    if (!stepMatch) throw new Error(`Invalid cron ${FIELD_NAMES[index]} "${field}"`)
    const [, rangePart, stepRaw] = stepMatch
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in ${FIELD_NAMES[index]} "${field}"`)

    let lo: number
    let hi: number
    if (rangePart === "*") {
      lo = min
      hi = max
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart)
      hi = stepRaw ? max : lo
    } else {
      const range = rangePart.match(/^(\d+)-(\d+)$/)
      if (!range) throw new Error(`Invalid cron ${FIELD_NAMES[index]} "${field}"`)
      lo = Number(range[1])
      hi = Number(range[2])
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Cron ${FIELD_NAMES[index]} "${field}" out of range ${min}-${max}`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values
}

/** Parses a 5-field cron expression; throws with a user-facing message. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Cron must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseField(f, i))
  // 7 is Sunday too
  if (dayOfWeek.has(7)) dayOfWeek.add(0)
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*"
  }
}

/** True when the spec fires at the given instant's UTC minute. */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getUTCMinutes())) return false
  if (!spec.hour.has(date.getUTCHours())) return false
  if (!spec.month.has(date.getUTCMonth() + 1)) return false
  const domMatch = spec.dayOfMonth.has(date.getUTCDate())
  const dowMatch = spec.dayOfWeek.has(date.getUTCDay())
  // Vixie rule: both day fields restricted means either may match
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

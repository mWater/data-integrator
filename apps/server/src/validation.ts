/**
 * Data-quality rules from a definition's `validation` block and its enum
 * columns, evaluated on what each run wrote. Violations flag the run; they
 * never reject its data, so a source that legitimately moves outside a
 * declared range keeps loading while the operator is told.
 *
 * Tables are checked exactly, over the rows the run wrote (`_run_id`).
 * Raster bands are checked against approximate statistics (GDAL reads
 * overviews when present), which is cheap enough to run on every snapshot
 * and still catches sentinels and unit mistakes.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import pg from "pg"
import { IntegrationDefinition, RangeRule } from "@data-integrator/definitions"

const execFileP = promisify(execFile)

/** One data-quality finding on a run. */
export interface RunFlag {
  /** tableId or layerId */
  destinationId: string
  /** Column id or band id */
  field: string
  /** Which rule raised it */
  rule: "range" | "enum"
  /** Values outside the rule (tables); absent for rasters */
  count?: number
  /** Observed minimum (rasters, approximate) */
  observedMin?: number
  /** Observed maximum (rasters, approximate) */
  observedMax?: number
  /** One-line description for logs, the UI and the agent */
  message: string
}

/** Quotes an identifier already validated by the definition grammar. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Describes a range rule's bounds, e.g. "0 to 500" or "at least 0". */
function bounds(rule: RangeRule): string {
  if (rule.min !== undefined && rule.max !== undefined) return `${rule.min} to ${rule.max}`
  return rule.min !== undefined ? `at least ${rule.min}` : `at most ${rule.max}`
}

/**
 * Range rules on table columns and vocabulary checks on enum columns, over
 * the rows this run wrote. Runs inside the commit transaction, so it sees
 * exactly what the run is about to commit.
 */
export async function evaluateTableRules(
  client: pg.ClientBase,
  definition: IntegrationDefinition,
  schema: string,
  runId: string,
  writtenTables: string[]
): Promise<RunFlag[]> {
  const flags: RunFlag[] = []
  const ranges = definition.validation?.ranges ?? []
  for (const dest of definition.destinations) {
    if (dest.kind !== "table" || !writtenTables.includes(dest.tableId)) continue
    const checks: { field: string; rule: "range" | "enum"; sql: string; params: unknown[]; describe: string }[] = []
    for (const rule of ranges) {
      if (rule.destinationId !== dest.tableId || (rule.min === undefined && rule.max === undefined)) continue
      const column = dest.columns.find(c => c.id === rule.field)
      if (!column || (column.type !== "number" && column.type !== "integer")) continue
      const parts: string[] = []
      const params: unknown[] = []
      if (rule.min !== undefined) parts.push(`${ident(rule.field)} < $${params.push(rule.min) + 1}`)
      if (rule.max !== undefined) parts.push(`${ident(rule.field)} > $${params.push(rule.max) + 1}`)
      checks.push({ field: rule.field, rule: "range", sql: parts.join(" OR "), params, describe: `outside ${bounds(rule)}` })
    }
    for (const column of dest.columns) {
      if (column.type !== "enum" || !column.enumValues?.length) continue
      checks.push({
        field: column.id,
        rule: "enum",
        sql: `${ident(column.id)} IS NOT NULL AND NOT (${ident(column.id)} = ANY($2::text[]))`,
        params: [column.enumValues.map(v => v.id)],
        describe: "not in the column's codes"
      })
    }
    for (const check of checks) {
      const result = await client.query(
        `SELECT count(*)::bigint AS n FROM ${ident(schema)}.${ident(dest.tableId)} WHERE _run_id = $1 AND (${check.sql})`,
        [runId, ...check.params]
      )
      const count = Number(result.rows[0].n)
      if (count === 0) continue
      flags.push({
        destinationId: dest.tableId,
        field: check.field,
        rule: check.rule,
        count,
        message: `${dest.tableId}.${check.field}: ${count} ${count === 1 ? "value" : "values"} ${check.describe}`
      })
    }
  }
  return flags
}

/** Approximate minimum and maximum of each band of a file, in band order; null entries where GDAL cannot tell. */
async function bandRanges(file: string): Promise<({ min: number; max: number } | null)[]> {
  try {
    // PAM off: the store is immutable, so no .aux.xml may land beside the file
    const { stdout } = await execFileP("gdalinfo", ["-json", "-approx_stats", file], {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GDAL_PAM_ENABLED: "NO" }
    })
    const info = JSON.parse(stdout) as { bands?: { minimum?: number; maximum?: number }[] }
    return (info.bands ?? []).map(b => (b.minimum === undefined || b.maximum === undefined ? null : { min: b.minimum, max: b.maximum }))
  } catch {
    return []
  }
}

/**
 * Range rules on raster bands, for one stored snapshot. `bandIds` is the
 * layer's band order; `files` are the snapshot's absolute source paths.
 */
export async function evaluateRasterRules(
  definition: IntegrationDefinition,
  layerId: string,
  bandIds: string[],
  files: string[]
): Promise<RunFlag[]> {
  const rules = (definition.validation?.ranges ?? []).filter(
    rule => rule.destinationId === layerId && bandIds.includes(rule.field) && (rule.min !== undefined || rule.max !== undefined)
  )
  if (rules.length === 0) return []
  const perFile = await Promise.all(files.map(bandRanges))
  const flags: RunFlag[] = []
  for (const rule of rules) {
    const index = bandIds.indexOf(rule.field)
    let min = Infinity
    let max = -Infinity
    for (const ranges of perFile) {
      const range = ranges[index]
      if (!range) continue
      min = Math.min(min, range.min)
      max = Math.max(max, range.max)
    }
    if (min === Infinity) continue
    if ((rule.min !== undefined && min < rule.min) || (rule.max !== undefined && max > rule.max)) {
      flags.push({
        destinationId: layerId,
        field: rule.field,
        rule: "range",
        observedMin: min,
        observedMax: max,
        message: `${layerId}.${rule.field}: values span ${min} to ${max}, outside ${bounds(rule)}`
      })
    }
  }
  return flags
}

/** ISO 8601 duration (P1D, PT6H, P1M, P10D, P1W...) in milliseconds; months are 30 days, years 365. Null when malformed. */
export function durationMs(iso: string): number | null {
  const match = iso.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!match || iso === "P" || iso.endsWith("T")) return null
  const [y, mo, w, d, h, mi, s] = match.slice(1).map(v => Number(v ?? 0))
  const days = y * 365 + mo * 30 + w * 7 + d
  return ((days * 24 + h) * 60 + mi) * 60_000 + s * 1000
}

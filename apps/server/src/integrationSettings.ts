/**
 * Declared integration settings: validation of a definition's `settings` and
 * `settingValues`, and resolution of the values a run passes to job code as
 * ctx.params.
 */

import { IntegrationDefinition, SettingSpec, SettingValue } from "@data-integrator/definitions"

/** Setting ids follow the same rule as other definition ids. */
const SETTING_ID = /^[a-z][a-z0-9_]{0,62}$/

/** Longest text value accepted, so a setting cannot smuggle a payload into every run. */
const TEXT_MAX_LENGTH = 1000

/** Why a value is not valid for a setting, or null when it is. */
export function settingValueProblem(spec: SettingSpec, value: unknown): string | null {
  switch (spec.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be an integer"
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`
      return null
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false"
    case "choice":
      return typeof value === "string" && (spec.choices ?? []).some(c => c.value === value)
        ? null
        : `must be one of ${(spec.choices ?? []).map(c => c.value).join(", ")}`
    case "text":
      if (typeof value !== "string") return "must be text"
      if (value.length > TEXT_MAX_LENGTH) return `must be at most ${TEXT_MAX_LENGTH} characters`
      if (spec.pattern !== undefined && !new RegExp(`^(?:${spec.pattern})$`).test(value)) {
        return `must match ${spec.pattern}`
      }
      return null
    default:
      return "has an unknown type"
  }
}

/** Problems with a definition's declared settings and its values for them. */
export function settingsProblems(definition: IntegrationDefinition): string[] {
  const problems: string[] = []
  const specs = definition.settings ?? {}
  if (typeof specs !== "object" || Array.isArray(specs)) return ["settings must be an object keyed by setting id"]
  for (const [id, spec] of Object.entries(specs)) {
    const at = `settings.${id}`
    if (!SETTING_ID.test(id)) problems.push(`${at}: id must match ${SETTING_ID}`)
    if (!["integer", "boolean", "choice", "text"].includes(spec?.type)) {
      problems.push(`${at}.type must be integer, boolean, choice, or text`)
      continue
    }
    if (spec.appliesOn !== undefined && spec.appliesOn !== "every-run" && spec.appliesOn !== "rebuild") {
      problems.push(`${at}.appliesOn must be "every-run" or "rebuild"`)
    }
    if (spec.type === "integer" && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
      problems.push(`${at}: min is above max`)
    }
    if (spec.type === "choice") {
      const values = (spec.choices ?? []).map(c => c?.value)
      if (values.length === 0) problems.push(`${at}.choices must list at least one value`)
      if (new Set(values).size !== values.length) problems.push(`${at}.choices has duplicate values`)
      if (values.some(v => typeof v !== "string")) problems.push(`${at}.choices values must be text`)
    }
    if (spec.type === "text" && spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern)
      } catch {
        problems.push(`${at}.pattern is not a valid regular expression`)
        continue
      }
    }
    const defaultProblem = settingValueProblem(spec, spec.default)
    if (defaultProblem) problems.push(`${at}.default ${defaultProblem}`)
  }
  const values = definition.settingValues ?? {}
  if (typeof values !== "object" || Array.isArray(values)) {
    problems.push("settingValues must be an object keyed by setting id")
    return problems
  }
  for (const [id, value] of Object.entries(values)) {
    const spec = specs[id]
    if (!spec) {
      problems.push(`settingValues.${id}: no such setting is declared`)
      continue
    }
    const problem = settingValueProblem(spec, value)
    if (problem) problems.push(`settingValues.${id} ${problem}`)
  }
  return problems
}

/**
 * The values a run passes to job code as ctx.params: every declared setting,
 * at the deployment's value or else the default. Undeclared values never
 * reach the code.
 */
export function resolveSettings(definition: IntegrationDefinition): Record<string, SettingValue> {
  const resolved: Record<string, SettingValue> = {}
  // Drafts reach here unvalidated (designer snippets), so malformed specs are skipped, not thrown on
  for (const [id, spec] of Object.entries(definition.settings ?? {})) {
    if (!spec || typeof spec !== "object") continue
    const value = definition.settingValues?.[id]
    resolved[id] = value !== undefined && settingValueProblem(spec, value) === null ? value : spec.default
  }
  return resolved
}

/**
 * The values from `values` that are still valid under `specs`: a library
 * update keeps the deployment's choices for settings it still declares, and
 * drops the rest rather than refusing the update.
 */
export function keepValidSettingValues(
  values: Record<string, SettingValue> | undefined,
  specs: Record<string, SettingSpec> | undefined
): Record<string, SettingValue> {
  const kept: Record<string, SettingValue> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    const spec = specs?.[id]
    if (spec && settingValueProblem(spec, value) === null) kept[id] = value
  }
  return kept
}

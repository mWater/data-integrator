/**
 * Definition-text localization: wrapping the designer's plain strings into
 * LocalizedString objects, and the batched model pass that fills the
 * deployment's configured locales. Definitions store strictly LocalizedString
 * for every human-facing field; plain strings exist only at the agent-tool
 * boundary and are wrapped here.
 */

import pg from "pg"
import { generateObject, LanguageModel } from "ai"
import { z } from "zod"
import {
  IntegrationDefinition,
  LocalizedString,
  SUPPORTED_LOCALES,
  toLocalizedString
} from "@data-integrator/definitions"

/** A definition draft whose localizable fields may still be plain strings. */
type DraftDefinition = IntegrationDefinition & Record<string, unknown>

/** Wraps one field value: plain string becomes a LocalizedString based in `base`. */
function wrap(value: unknown, base: string): unknown {
  if (typeof value === "string") return toLocalizedString(value, base)
  return value
}

/**
 * Wraps every localizable field of a draft definition that is still a plain
 * string, using `base` as the authored language. Existing LocalizedString
 * values pass through untouched, so re-wrapping is idempotent and library
 * definitions (already localized) are unaffected. Returns a new object.
 */
export function wrapDefinitionStrings(definition: IntegrationDefinition, base: string): IntegrationDefinition {
  const d = structuredClone(definition) as DraftDefinition
  d.name = wrap(d.name, base) as LocalizedString
  if (d.description !== undefined) d.description = wrap(d.description, base) as LocalizedString
  if (d.source) {
    d.source.name = wrap(d.source.name, base) as LocalizedString
    if (d.source.limitations !== undefined) d.source.limitations = wrap(d.source.limitations, base) as LocalizedString
  }
  for (const slot of Object.values(d.files ?? {})) {
    if (slot.description !== undefined) slot.description = wrap(slot.description, base) as LocalizedString
  }
  for (const setting of Object.values(d.settings ?? {})) {
    setting.label = wrap(setting.label, base) as LocalizedString
    if (setting.description !== undefined) setting.description = wrap(setting.description, base) as LocalizedString
    for (const choice of setting.choices ?? []) choice.label = wrap(choice.label, base) as LocalizedString
  }
  for (const dest of d.destinations ?? []) {
    const destAny = dest as unknown as Record<string, unknown>
    if (destAny.name !== undefined) destAny.name = wrap(destAny.name, base)
    if (destAny.description !== undefined) destAny.description = wrap(destAny.description, base)
    if (dest.kind === "table") {
      for (const column of dest.columns ?? []) {
        if (column.name !== undefined) column.name = wrap(column.name, base) as LocalizedString
        for (const enumValue of column.enumValues ?? []) {
          enumValue.name = wrap(enumValue.name, base) as LocalizedString
        }
      }
    } else if (dest.kind === "raster") {
      for (const band of dest.bands ?? []) {
        if (band.name !== undefined) band.name = wrap(band.name, base) as LocalizedString
      }
    }
  }
  return d
}

/**
 * Collects live references to every localizable LocalizedString in a
 * definition; mutating the returned objects mutates the definition. Explicit
 * paths, not a generic object walk: ids, units, code, and URLs must never be
 * treated as localizable.
 */
export function collectDefinitionStrings(definition: IntegrationDefinition): LocalizedString[] {
  const out: LocalizedString[] = []
  const push = (value: LocalizedString | string | undefined) => {
    if (value && typeof value === "object" && value._base) out.push(value as LocalizedString)
  }
  push(definition.name)
  push(definition.description)
  push(definition.source?.name)
  push(definition.source?.limitations)
  for (const slot of Object.values(definition.files ?? {})) push(slot.description)
  for (const setting of Object.values(definition.settings ?? {})) {
    push(setting.label)
    push(setting.description)
    for (const choice of setting.choices ?? []) push(choice.label)
  }
  for (const dest of definition.destinations ?? []) {
    push(dest.name)
    push(dest.description)
    if (dest.kind === "table") {
      for (const column of dest.columns ?? []) {
        push(column.name)
        for (const enumValue of column.enumValues ?? []) push(enumValue.name)
      }
    } else if (dest.kind === "raster") {
      for (const band of dest.bands ?? []) push(band.name)
    }
  }
  return out
}

/** Problems found by validateDefinitionStrings, keyed by a rough field path. */
export function validateDefinitionStrings(definition: IntegrationDefinition): string[] {
  const errors: string[] = []
  const check = (value: unknown, path: string, required: boolean) => {
    if (value === undefined) {
      if (required) errors.push(`${path} is required`)
      return
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path} must be a LocalizedString object ({ _base, <locale>: text }), got ${typeof value}`)
      return
    }
    const ls = value as LocalizedString
    if (typeof ls._base !== "string" || typeof ls[ls._base] !== "string") {
      errors.push(`${path} must carry _base and the base-locale text`)
    }
  }
  check(definition.name, "name", true)
  check(definition.description, "description", false)
  if (definition.source) {
    check(definition.source.name, "source.name", true)
    check(definition.source.limitations, "source.limitations", false)
  }
  for (const [slotId, slot] of Object.entries(definition.files ?? {})) {
    check(slot?.description, `files.${slotId}.description`, false)
  }
  for (const [settingId, setting] of Object.entries(definition.settings ?? {})) {
    check(setting?.label, `settings.${settingId}.label`, true)
    check(setting?.description, `settings.${settingId}.description`, false)
    setting?.choices?.forEach((choice, k) => check(choice?.label, `settings.${settingId}.choices[${k}].label`, true))
  }
  definition.destinations?.forEach((dest, i) => {
    const at = `destinations[${i}]`
    check(dest.name, `${at}.name`, false)
    check(dest.description, `${at}.description`, false)
    if (dest.kind === "table") {
      dest.columns?.forEach((column, j) => {
        check(column.name, `${at}.columns[${j}].name`, false)
        column.enumValues?.forEach((enumValue, k) => check(enumValue.name, `${at}.columns[${j}].enumValues[${k}].name`, true))
      })
    } else if (dest.kind === "raster") {
      dest.bands?.forEach((band, j) => check(band.name, `${at}.bands[${j}].name`, false))
    }
  })
  return errors
}

/** Locale codes of the release ceiling, for validation. */
const CEILING = new Set(SUPPORTED_LOCALES.map(l => l.code))

/**
 * Detects the language of a definition's headline text with one small model
 * call; returns a supported locale code, or the fallback when detection fails
 * or lands outside the supported set.
 */
export async function detectBaseLocale(model: LanguageModel, sampleText: string, fallback: string): Promise<string> {
  try {
    const { object } = await generateObject({
      model,
      schema: z.object({ locale: z.string().describe("ISO 639-1 code of the text's language") }),
      prompt: `Identify the language of this text. Answer with the ISO 639-1 code only.\n\n${sampleText.slice(0, 500)}`
    })
    const code = object.locale.trim().toLowerCase().split("-")[0]
    return CEILING.has(code) ? code : fallback
  } catch {
    return fallback
  }
}

/** One string sent to the translation model. */
const translationSchema = z.object({
  translations: z
    .array(
      z.object({
        index: z.number().int().describe("Index of the source string"),
        locale: z.string().describe("Target locale code"),
        text: z.string().describe("The translation")
      })
    )
    .describe("One entry per requested (string, locale) pair")
})

/**
 * Fills missing locales on every localizable string of a definition, in one
 * batched model call. Mutates the definition's strings in place and returns
 * how many translations were written. Strings already carrying a target locale
 * are left alone, so the pass is incremental and re-runnable; callers that
 * detect a changed base text should delete the stale locale keys first
 * (see refreshChangedStrings).
 */
export async function translateDefinition(
  model: LanguageModel,
  definition: IntegrationDefinition,
  targetLocales: string[]
): Promise<number> {
  const strings = collectDefinitionStrings(definition)
  const wanted: { index: number; locale: string }[] = []
  strings.forEach((value, index) => {
    for (const locale of targetLocales) {
      if (locale !== value._base && value[locale] === undefined) wanted.push({ index, locale })
    }
  })
  if (wanted.length === 0) return 0

  const sources = strings.map((value, index) => ({ index, locale: value._base, text: value[value._base] }))
  const localeNames = Object.fromEntries(SUPPORTED_LOCALES.map(l => [l.code, l.name]))
  const { object } = await generateObject({
    model,
    schema: translationSchema,
    prompt: [
      "Translate data-catalog strings for a water/climate data platform (dataset names,",
      "descriptions, column labels, caveats). Keep technical terms, proper nouns, units,",
      "and acronyms (GloFAS, COG, SPI-3) as a domain expert writing in the target language",
      "would. Keep each translation about as long as its source. Do not translate",
      "placeholder-like content or identifiers.",
      "",
      `Source strings (JSON): ${JSON.stringify(sources)}`,
      "",
      `Produce translations for exactly these (index, locale) pairs: ${JSON.stringify(wanted)}`,
      `Locale names: ${JSON.stringify(localeNames)}`
    ].join("\n")
  })

  let written = 0
  const wantedKeys = new Set(wanted.map(w => `${w.index}:${w.locale}`))
  for (const t of object.translations) {
    if (!wantedKeys.has(`${t.index}:${t.locale}`)) continue
    const target = strings[t.index]
    if (!target || typeof t.text !== "string" || t.text.trim() === "") continue
    target[t.locale] = t.text
    written++
  }
  return written
}

/**
 * Prepares an edited definition for re-translation: for every string whose
 * base text differs from the previous version's (matched by position in the
 * collect order being unreliable across edits, matching is by base text), the
 * stale translations are dropped so translateDefinition regenerates them.
 * Unchanged strings keep their translations.
 */
export function refreshChangedStrings(definition: IntegrationDefinition, previous: IntegrationDefinition | null): void {
  if (!previous) return
  // Base texts that existed before, with their translation sets
  const known = new Map<string, LocalizedString>()
  for (const value of collectDefinitionStrings(previous)) {
    known.set(`${value._base} ${value[value._base]}`, value)
  }
  for (const value of collectDefinitionStrings(definition)) {
    const match = known.get(`${value._base} ${value[value._base]}`)
    if (match) {
      // Same base text as before: carry the old translations forward
      for (const key of Object.keys(match)) {
        if (key !== "_base" && value[key] === undefined) value[key] = match[key]
      }
    } else {
      // New or edited base text: drop any translations that rode along stale
      for (const key of Object.keys(value)) {
        if (key !== "_base" && key !== value._base) delete value[key]
      }
    }
  }
}

/** Outcome of one pass over the installed catalog. */
export interface CatalogTranslationResult {
  /** Integrations whose stored definition changed */
  integrations: number
  /** Translated strings written */
  translations: number
  /** "integrationId: message" for integrations that failed */
  failures: string[]
}

/** State of the background catalog translation, for the settings page. */
export interface CatalogTranslationStatus {
  /** True while a pass is running */
  running: boolean
  /** Locales the running or last pass targeted */
  locales: string[]
  /** Start time of the running or last pass (ISO); null when never run */
  startedAt: string | null
  /** Finish time of the last pass (ISO); null while running or never run */
  finishedAt: string | null
  /** Result of the last pass; null while running or never run */
  result: CatalogTranslationResult | null
}

/**
 * Fills missing translations across every installed definition and pushes the
 * translated destination specs into the catalog copies (data_tables.spec,
 * raster_layers), which otherwise refresh only when an integration runs.
 * Translation-only changes update the stored definition in place: canonical
 * identity ignores translations, so no version is archived.
 */
export async function translateCatalog(
  pool: pg.Pool,
  model: LanguageModel,
  locales: string[]
): Promise<CatalogTranslationResult> {
  const installed = await pool.query("SELECT id, definition FROM app.integrations ORDER BY id")
  const result: CatalogTranslationResult = { integrations: 0, translations: 0, failures: [] }
  for (const row of installed.rows) {
    try {
      // Definitions installed before localization hold plain English strings;
      // wrapping is a no-op on already-localized ones
      const definition = wrapDefinitionStrings(row.definition, "en")
      const written = await translateDefinition(model, definition, locales)
      const wrapped = JSON.stringify(definition) !== JSON.stringify(row.definition)
      if (written > 0 || wrapped) {
        await pool.query("UPDATE app.integrations SET definition = $2 WHERE id = $1", [
          row.id,
          JSON.stringify(definition)
        ])
        result.integrations++
        result.translations += written
      }
      for (const dest of definition.destinations ?? []) {
        if (dest.kind === "table") {
          await pool.query(
            `UPDATE app.data_tables SET spec = $3, updated_at = now()
             WHERE id = $1 AND integration_id = $2`,
            [dest.tableId, row.id, JSON.stringify(dest)]
          )
        } else if (dest.kind === "raster") {
          await pool.query(
            `UPDATE app.raster_layers SET name = $3, bands = $4
             WHERE id = $1 AND integration_id = $2 AND session_id IS NULL`,
            [
              dest.layerId,
              row.id,
              JSON.stringify(dest.name ?? { _base: "en", en: dest.layerId }),
              JSON.stringify(dest.bands)
            ]
          )
        }
      }
    } catch (err) {
      result.failures.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}

/** The one in-process translation pass; a second start while running is a no-op. */
let catalogJob: CatalogTranslationStatus = {
  running: false,
  locales: [],
  startedAt: null,
  finishedAt: null,
  result: null
}

/** Current state of the background catalog translation. */
export function catalogTranslationStatus(): CatalogTranslationStatus {
  return { ...catalogJob, locales: [...catalogJob.locales], result: catalogJob.result }
}

/**
 * Starts a catalog translation pass in the background and returns at once.
 * A pass over a real catalog outlasts proxy timeouts, so requests never wait
 * on it; the settings page polls the status instead.
 */
export function startCatalogTranslation(pool: pg.Pool, model: LanguageModel, locales: string[]): CatalogTranslationStatus {
  if (catalogJob.running) return catalogTranslationStatus()
  catalogJob = { running: true, locales, startedAt: new Date().toISOString(), finishedAt: null, result: null }
  void translateCatalog(pool, model, locales)
    .then(result => {
      catalogJob = { ...catalogJob, running: false, finishedAt: new Date().toISOString(), result }
    })
    .catch(err => {
      catalogJob = {
        ...catalogJob,
        running: false,
        finishedAt: new Date().toISOString(),
        result: { integrations: 0, translations: 0, failures: [err instanceof Error ? err.message : String(err)] }
      }
    })
  return catalogTranslationStatus()
}

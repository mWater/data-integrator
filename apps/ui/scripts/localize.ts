/**
 * Localization tool for the mWater Data Integrator UI.
 *
 * Extracts every T`...` string from src/ into src/localizations.json, and can
 * fill in missing translations with a language model or hand them to a human
 * translator as a spreadsheet. Run from apps/ui:
 *
 *   pnpm localize                              extract strings only
 *   pnpm localize --translate all              extract, then translate every locale
 *   pnpm localize --translate fr,pt            translate just these locales
 *   pnpm localize --export fr                  write localizations-fr.xlsx
 *   pnpm localize --import fr --file f.xlsx    merge a translated spreadsheet back
 *
 * Translation needs OPENROUTER_API_KEY or ANTHROPIC_API_KEY, read from the
 * environment or the repository-root .env. Extraction and export need neither.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateObject, type LanguageModel } from "ai"
import { updateLocalizationFile } from "ez-localize/lib/extractor"
import { exportXlsx, importXlsx, updateLocalizedStrings } from "ez-localize/lib/utils"
import { z } from "zod"

/** One catalog entry: the English key plus a translation per locale code. */
interface LocalizedString {
  /** Locale the other values are translated from; always "en" here. */
  _base: string
  [locale: string]: string
}

/** The on-disk shape of localizations.json. */
interface LocalizerData {
  /** Locales offered in the UI, in picker order. */
  locales: { code: string; name: string }[]
  /** Every extracted string with its translations. */
  strings: LocalizedString[]
  /** English keys the extractor no longer finds in the source. */
  unused?: string[]
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.join(HERE, "..")
const REPO_ROOT = path.join(UI_ROOT, "../..")
const CATALOG = path.join(UI_ROOT, "src/localizations.json")
const SOURCES = [path.join(UI_ROOT, "src")]
const CONTEXT_FILE = path.join(HERE, "translation-context.md")

/** Strings sent to the model per request. */
const BATCH_SIZE = 40

/** Requests in flight at once. */
const CONCURRENCY = 4

/** Default translation model; keep equal to DEFAULT_MODELS.openrouter in apps/server/src/aiSettings.ts. */
const DEFAULT_MODEL = "openai/gpt-6.1-sol"

/**
 * Fills process.env from the repository-root .env for keys it does not already
 * define, so the script works whether or not it was started with --env-file.
 */
async function loadEnv(): Promise<void> {
  let text: string
  try {
    text = await fs.readFile(path.join(REPO_ROOT, ".env"), "utf-8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2")
    process.env[match[1]] ??= value
  }
}

/** Reads the catalog from disk. */
async function readCatalog(): Promise<LocalizerData> {
  return JSON.parse(await fs.readFile(CATALOG, "utf-8")) as LocalizerData
}

/** Writes the catalog back, preserving key order and two-space indentation. */
async function writeCatalog(data: LocalizerData): Promise<void> {
  await fs.writeFile(CATALOG, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

/** Extracts T`...` strings from src/ into the catalog, adding new keys in place. */
async function extract(): Promise<void> {
  await new Promise<void>(resolve => updateLocalizationFile(SOURCES, CATALOG, {}, resolve))
  const data = await readCatalog()
  console.log(`Extracted ${data.strings.length} strings from ${SOURCES.length} source root(s).`)
  if (data.unused?.length) {
    console.log(`${data.unused.length} string(s) in the catalog are no longer used in the source.`)
  }
}

/**
 * The model to translate with: OpenRouter when its key is set, else Anthropic.
 * AGENT_MODEL overrides the default on either provider.
 */
function buildModel(): LanguageModel {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (openrouterKey) {
    return createOpenRouter({ apiKey: openrouterKey })(process.env.AGENT_MODEL ?? DEFAULT_MODEL)
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })(process.env.AGENT_MODEL ?? "claude-opus-5-5")
  }
  throw new Error("Translation needs OPENROUTER_API_KEY or ANTHROPIC_API_KEY")
}

/** Translator guidance shared by every request, from translation-context.md. */
async function readContext(): Promise<string> {
  try {
    return await fs.readFile(CONTEXT_FILE, "utf-8")
  } catch {
    return ""
  }
}

/** Translates one batch of English phrases, returning them in the same order. */
async function translateBatch(
  model: LanguageModel,
  phrases: string[],
  localeName: string,
  context: string
): Promise<string[]> {
  const { object } = await generateObject({
    model,
    schema: z.object({
      translations: z
        .array(z.string())
        .describe("Translations, one per input phrase, in the same order")
    }),
    system:
      `You translate user interface strings for mWater Data Integrator, an open-source platform ` +
      `for ingesting and harmonizing water and climate data. Translate from English into ` +
      `${localeName}.\n\n` +
      `Rules:\n` +
      `- Return exactly one translation per input phrase, in the same order.\n` +
      `- Preserve placeholders like {0} and {1} exactly, including their order of meaning; ` +
      `their position in the sentence may change to suit the target language.\n` +
      `- Preserve leading and trailing whitespace, ellipses (…), and surrounding punctuation.\n` +
      `- Keep the register terse and functional: these are buttons, headings and status ` +
      `messages, not prose.\n` +
      `- Leave proper nouns, format names and identifiers untranslated (mWater Data Integrator, ` +
      `PostgreSQL, PostGIS, GeoTIFF, CSV, WorldPop, CHIRPS).\n` +
      (context ? `\n${context}` : ""),
    prompt: JSON.stringify(phrases, null, 2)
  })
  if (object.translations.length !== phrases.length) {
    throw new Error(
      `Model returned ${object.translations.length} translations for ${phrases.length} phrases`
    )
  }
  return object.translations
}

/** Runs tasks with a bounded number in flight, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Fills in every missing translation for one locale, writing the catalog after
 * each locale so an interrupted run keeps the work it finished.
 */
async function translateLocale(
  model: LanguageModel,
  data: LocalizerData,
  code: string,
  context: string
): Promise<void> {
  const locale = data.locales.find(l => l.code === code)
  if (!locale) {
    console.warn(`Unknown locale ${code}; add it to localizations.json first. Skipping.`)
    return
  }
  const pending = data.strings.filter(s => s.en?.trim() && !s[code]?.trim())
  if (pending.length === 0) {
    console.log(`${locale.name}: nothing to translate.`)
    return
  }

  const batches: LocalizedString[][] = []
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE))
  }
  console.log(`${locale.name}: translating ${pending.length} string(s) in ${batches.length} batch(es)…`)

  let failed = 0
  await mapLimit(batches, CONCURRENCY, async (batch, index) => {
    try {
      const translations = await translateBatch(
        model,
        batch.map(s => s.en),
        locale.name,
        context
      )
      batch.forEach((entry, i) => {
        entry[code] = translations[i]
        entry._base = "en"
      })
      console.log(`  ${locale.name} batch ${index + 1}/${batches.length} done`)
    } catch (err) {
      failed++
      console.error(`  ${locale.name} batch ${index + 1}/${batches.length} failed:`, err)
    }
  })

  if (failed > 0) {
    console.warn(`${locale.name}: ${failed} batch(es) failed; re-run to retry just those strings.`)
  }
}

/** Writes an English/target spreadsheet for a human translator. */
async function exportSpreadsheet(data: LocalizerData, code: string): Promise<void> {
  const target = data.locales.find(l => l.code === code)
  const english = data.locales.find(l => l.code === "en")
  if (!target || !english) throw new Error(`Locale ${code} is not in localizations.json`)
  const base64 = exportXlsx([english, target], data.strings)
  const file = path.join(REPO_ROOT, `localizations-${code}.xlsx`)
  await fs.writeFile(file, Buffer.from(base64, "base64"))
  console.log(`Wrote ${file}`)
}

/** Merges a translated spreadsheet back into the catalog for one locale. */
async function importSpreadsheet(data: LocalizerData, code: string, file: string): Promise<void> {
  const base64 = await fs.readFile(path.resolve(file), { encoding: "base64" })
  const imported = importXlsx(data.locales, base64)
  updateLocalizedStrings(data.strings, imported, code)
  console.log(`Imported ${imported.length} string(s) for ${code} from ${file}`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      translate: { type: "string" },
      export: { type: "string" },
      import: { type: "string" },
      file: { type: "string" }
    }
  })

  await loadEnv()

  // Export reads the catalog as-is; every other action starts from a fresh extraction.
  if (!values.export) await extract()

  const data = await readCatalog()

  if (values.translate) {
    const codes =
      values.translate === "all"
        ? data.locales.map(l => l.code).filter(c => c !== "en")
        : values.translate.split(",").map(s => s.trim()).filter(Boolean)
    const model = buildModel()
    const context = await readContext()
    for (const code of codes) {
      await translateLocale(model, data, code, context)
      await writeCatalog(data)
    }
  } else if (values.export) {
    await exportSpreadsheet(data, values.export)
    return
  } else if (values.import) {
    if (!values.file) throw new Error("--import needs --file <path to .xlsx>")
    await importSpreadsheet(data, values.import, values.file)
    await writeCatalog(data)
  }

  const missing = data.locales
    .filter(l => l.code !== "en")
    .map(l => ({ name: l.name, count: data.strings.filter(s => !s[l.code]?.trim()).length }))
    .filter(l => l.count > 0)
  if (missing.length > 0) {
    console.log(
      `Untranslated: ${missing.map(m => `${m.name} ${m.count}`).join(", ")}. ` +
        `Run with --translate all to fill them in.`
    )
  } else {
    console.log("Every locale is fully translated.")
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

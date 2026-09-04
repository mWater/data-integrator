/**
 * ez-localize setup. The global `T` is assigned before the first render (see
 * applyLocale in main.tsx and the locale state in App), so every localized
 * string must be produced at render/call time, never at module evaluation, or a
 * locale change will not reach it without a reload.
 */
import cronstrue from "cronstrue"
import { type LocalizedString } from "@data-integrator/definitions"
import { Localizer, type LocalizerData } from "ez-localize"
import localizations from "./localizations.json"

/** localStorage key holding the operator's chosen locale. */
const LOCALE_KEY = "dataIntegrator.locale"

const data = localizations as LocalizerData

/** Locale the global T is currently pointed at. */
let activeLocale = "en"

/** Deployment-offered locale codes; null until settings load (offer everything). */
let offeredLocales: string[] | null = null

/** Narrows the picker to the deployment's offered locales (from settings). */
export function setOfferedLocales(codes: string[] | null): void {
  offeredLocales = codes
  // The picker lives in App; tell it the offer changed so it re-renders
  window.dispatchEvent(new Event("locales:changed"))
}

/** Locales offered in the language picker: the catalog's, narrowed by the deployment setting. */
export function availableLocales(): { code: string; name: string }[] {
  if (!offeredLocales) return data.locales
  const offered = data.locales.filter(l => offeredLocales!.includes(l.code))
  return offered.length > 0 ? offered : data.locales
}

/**
 * Resolves a definition-sourced LocalizedString for the active locale, falling
 * back to the string's own base language (ez-localize's localizer falls back
 * to English instead, which loses untranslated non-English content).
 */
/** The locale the global T currently renders; sessions record it at creation. */
export function currentLocale(): string {
  return activeLocale
}

/**
 * A timestamp for display: the viewer's local time with its zone abbreviation
 * ("8/26/2026, 4:04 PM EAT"), so "last updated" never reads ambiguously across
 * offices. Accepts ISO strings and Dates; blank for nothing.
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  })
}

export function localizeData(value: LocalizedString | string | null | undefined): string {
  if (!value) return ""
  if (typeof value === "string") return value
  return value[activeLocale] ?? value[value._base] ?? ""
}

/**
 * The locale to start in: the saved choice, else the best match for the
 * browser's languages, else English.
 */
export function getSavedLocale(): string {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved && data.locales.some(l => l.code === saved)) return saved
  } catch {
    // Storage blocked (private mode, embedded webview) — fall through.
  }
  for (const language of navigator.languages ?? []) {
    const base = language.split("-")[0]
    if (data.locales.some(l => l.code === base)) return base
  }
  return "en"
}

/**
 * Locales written right to left, so the document direction has to flip. Adding
 * one also needs styles.css moved to logical properties; it still uses physical
 * left/right in about thirty places.
 */
const RTL_LOCALES = new Set<string>([])

/** Point the global `T` at a localizer for the given locale, persisting the choice. */
export function applyLocale(locale: string): void {
  const localizer = new Localizer(data, locale)
  ;(globalThis as any).T = localizer.localizeString
  activeLocale = locale
  document.documentElement.lang = locale
  document.documentElement.dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr"
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Best-effort: the locale still applies for this session.
  }
}

/**
 * cronstrue locale ids for the locales we offer. Absent means cronstrue has no
 * translation for it (Malagasy), and schedules stay in English.
 */
const CRONSTRUE_LOCALES: Record<string, string> = {
  es: "es",
  fr: "fr",
  pt: "pt_PT",
  sw: "sw"
}

/**
 * cronstrue's every-locale build. It is eight times the size of the default
 * English one, so it is fetched only once a non-English locale needs it.
 */
let cronstrueI18n: typeof cronstrue | null = null

/**
 * Loads the translated cron descriptions for a locale if there are any.
 * Resolves to true when a later cronText call will produce different output,
 * so the caller can re-render.
 */
export async function loadCronLocale(locale: string): Promise<boolean> {
  if (!CRONSTRUE_LOCALES[locale] || cronstrueI18n) return false
  cronstrueI18n = (await import("cronstrue/i18n")).default
  return true
}

/** A cron expression in plain language; unparseable expressions stay raw. */
export function cronText(cron: string): string {
  const localeId = CRONSTRUE_LOCALES[activeLocale]
  try {
    if (localeId && cronstrueI18n) {
      return cronstrueI18n.toString(cron, { use24HourTimeFormat: true, locale: localeId })
    }
    return cronstrue.toString(cron, { use24HourTimeFormat: true })
  } catch {
    return `cron ${cron}`
  }
}

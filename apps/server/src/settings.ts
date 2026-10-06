/**
 * Deployment settings stored in app.settings: behavior an administrator owns
 * and changes at runtime through the UI, as opposed to the infrastructure
 * wiring in config.ts which needs a restart. Values are jsonb; every key the
 * product understands is declared here with its validation.
 */

import pg from "pg"
import { Aoi, SUPPORTED_LOCALES } from "@data-integrator/definitions"
import { COUNTRIES } from "./countries.js"

/**
 * The deployment's default area of interest. Integrations installed without
 * an AOI of their own inherit it at run time, so a deployment configured for
 * one country points every library install at that country with no per-install
 * choice. `name` is the display label of the selection (e.g. the country name).
 */
export interface DefaultAoi extends Aoi {
  name?: string
}

/** Settings key for the deployment default AOI. */
export const DEFAULT_AOI_KEY = "default_aoi"

/** Settings key for the deployment's display name, shown as the home page title. */
export const SITE_TITLE_KEY = "site_title"

/** Title to fall back to when the deployment has not set one. */
export const DEFAULT_SITE_TITLE = "mWater Data Integrator"

/** Reads one setting; null when unset. */
export async function getSetting<T>(pool: pg.Pool, key: string): Promise<T | null> {
  const result = await pool.query("SELECT value FROM app.settings WHERE key = $1", [key])
  return result.rows.length > 0 ? (result.rows[0].value as T) : null
}

/** Writes one setting; null deletes it. */
export async function setSetting(pool: pg.Pool, key: string, value: unknown): Promise<void> {
  if (value === null) {
    await pool.query("DELETE FROM app.settings WHERE key = $1", [key])
    return
  }
  await pool.query(
    `INSERT INTO app.settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  )
}

/** Settings key for the deployment's offered locales (subset of SUPPORTED_LOCALES). */
export const LOCALES_KEY = "locales"

/**
 * The deployment's offered locales: what the language picker shows and what
 * the data-translation pass targets. Unset means the release's full list.
 */
export async function getLocales(pool: pg.Pool): Promise<string[]> {
  const value = await getSetting<string[]>(pool, LOCALES_KEY)
  const supported = SUPPORTED_LOCALES.map(l => l.code)
  if (!value) return supported
  const chosen = value.filter(code => supported.includes(code))
  return chosen.length > 0 ? chosen : supported
}

/**
 * Validates a locales setting value: a non-empty array of supported codes.
 * Returns the list normalized to SUPPORTED_LOCALES order.
 */
export function parseLocales(body: unknown): string[] {
  const raw = (body as { locales?: unknown })?.locales
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(v => typeof v === "string")) {
    throw new Error("locales must be a non-empty array of locale codes")
  }
  const supported = SUPPORTED_LOCALES.map(l => l.code)
  const unknown = raw.filter(code => !supported.includes(code))
  if (unknown.length > 0) throw new Error(`unsupported locales: ${unknown.join(", ")}`)
  return supported.filter(code => raw.includes(code))
}

/** The deployment default AOI, or null when none is configured. */
export async function getDefaultAoi(pool: pg.Pool): Promise<DefaultAoi | null> {
  return getSetting<DefaultAoi>(pool, DEFAULT_AOI_KEY)
}

/** The deployment's display name, or null when none is configured. */
export async function getSiteTitle(pool: pg.Pool): Promise<string | null> {
  return getSetting<string>(pool, SITE_TITLE_KEY)
}

/**
 * Validates a site-title setting value. Returns the trimmed title, or null when
 * it is blank, which clears the setting and restores the default.
 */
export function parseSiteTitle(body: unknown): string | null {
  const raw = (body as { title?: unknown })?.title
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string") throw new Error("title must be a string")
  return raw.trim().slice(0, 120) || null
}

/**
 * Validates an AOI value. Returns the normalized value, or throws with a
 * user-facing message. Accepts west > east (antimeridian).
 */
export function parseAoi(body: unknown): Aoi {
  const raw = body as { bbox?: unknown; countries?: unknown }
  const bbox = raw?.bbox
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(v => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("bbox must be [west, south, east, north] numbers")
  }
  const [west, south, east, north] = bbox as [number, number, number, number]
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new Error("bbox longitudes must be within [-180, 180]")
  }
  if (south < -90 || north > 90 || south >= north) {
    throw new Error("bbox latitudes must satisfy -90 <= south < north <= 90")
  }
  let countries: string[] | undefined
  if (raw.countries !== undefined) {
    if (!Array.isArray(raw.countries) || !raw.countries.every(c => typeof c === "string")) {
      throw new Error("countries must be an array of ISO3 codes")
    }
    countries = (raw.countries as string[]).map(c => c.toUpperCase())
    const known = new Set(COUNTRIES.map(c => c.iso3))
    const unknown = countries.filter(c => !known.has(c))
    if (unknown.length > 0) throw new Error(`Unknown country codes: ${unknown.join(", ")}`)
  }
  return { bbox: [west, south, east, north], ...(countries ? { countries } : {}) }
}

/** Validates a default-AOI setting value: an Aoi plus its display name. */
export function parseDefaultAoi(body: unknown): DefaultAoi {
  const aoi = parseAoi(body)
  const raw = body as { name?: unknown }
  const name = raw.name !== undefined ? String(raw.name).slice(0, 200) : undefined
  return { ...aoi, ...(name ? { name } : {}) }
}

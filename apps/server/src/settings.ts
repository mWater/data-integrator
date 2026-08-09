/**
 * Deployment settings stored in app.settings: behavior an administrator owns
 * and changes at runtime through the UI, as opposed to the infrastructure
 * wiring in config.ts which needs a restart. Values are jsonb; every key the
 * product understands is declared here with its validation.
 */

import pg from "pg"
import { Aoi } from "@data-integrator/definitions"
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

/** The deployment default AOI, or null when none is configured. */
export async function getDefaultAoi(pool: pg.Pool): Promise<DefaultAoi | null> {
  return getSetting<DefaultAoi>(pool, DEFAULT_AOI_KEY)
}

/**
 * Validates a default-AOI value from the API. Returns the normalized value,
 * or throws with a user-facing message. Accepts west > east (antimeridian).
 */
export function parseDefaultAoi(body: unknown): DefaultAoi {
  const raw = body as { bbox?: unknown; countries?: unknown; name?: unknown }
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
  const name = raw.name !== undefined ? String(raw.name).slice(0, 200) : undefined
  return { bbox: [west, south, east, north], ...(countries ? { countries } : {}), ...(name ? { name } : {}) }
}

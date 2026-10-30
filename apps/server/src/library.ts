/**
 * The browsable integration library: entries under
 * <libraryPath>/integrations/<id>/ (definition.json plus one code file).
 * Installing copies the entry's values into the integration's definition —
 * the single specification from then on. Updating re-installs the entry but
 * carries the deployment-owned fields over from the installed definition, so
 * a locally chosen AOI, schedule, limits, or setting values survive library
 * updates; the same fields are excluded from update detection.
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { LocalizedString, IntegrationDefinition, SettingValue } from "@data-integrator/definitions"
import { canonicalDefinition, installIntegration, ID_PATTERN } from "./install.js"
import { keepValidSettingValues } from "./integrationSettings.js"

/** Fields the deployment owns once installed: carried over on update, ignored in update detection. */
const DEPLOYMENT_FIELDS = ["aoi", "trigger", "limits", "settingValues"] as const

/** One library entry with its relationship to the deployment. */
export interface LibraryEntry {
  /** Entry id (= integration id when installed) */
  id: string
  /** Display name */
  name: LocalizedString
  /** What the integration does */
  description: LocalizedString | null
  /** Source provenance (name, provider, license, url) */
  source: unknown
  /** Suggested cadence */
  trigger: unknown
  /** Runtime image id */
  runtime: string
  /** Declared destinations: kind + id */
  destinations: { kind: string; id: string }[]
  /** Relationship to this deployment */
  status: "not_installed" | "installed" | "update_available"
  /** Installed version, when installed */
  installedVersion: number | null
}

/**
 * Canonical JSON with the deployment-owned fields stripped, for update
 * detection. Uses canonicalDefinition, so translation-only differences never
 * read as an update.
 */
function comparableJson(definition: IntegrationDefinition): string {
  const stripped: Record<string, unknown> = { ...definition }
  for (const field of DEPLOYMENT_FIELDS) delete stripped[field]
  return JSON.stringify(canonicalDefinition(stripped))
}

/** Loads one entry's full definition (code file inlined), or null. */
export async function loadLibraryEntry(libraryPath: string, id: string): Promise<IntegrationDefinition | null> {
  if (!ID_PATTERN.test(id)) return null
  const dir = path.join(libraryPath, "integrations", id)
  let definition: IntegrationDefinition
  try {
    definition = JSON.parse(await readFile(path.join(dir, "definition.json"), "utf8"))
  } catch {
    return null
  }
  for (const codeFile of ["code.py", "code.mjs"]) {
    const code = await readFile(path.join(dir, codeFile), "utf8").catch(() => null)
    if (code !== null) {
      definition.code = code
      return definition
    }
  }
  return null
}

/** Lists the library with each entry's installed/update status. */
export async function listLibrary(pool: pg.Pool, libraryPath: string): Promise<LibraryEntry[]> {
  let ids: string[]
  try {
    ids = (await readdir(path.join(libraryPath, "integrations"))).filter(id => ID_PATTERN.test(id)).sort()
  } catch {
    return []
  }
  const installed = await pool.query("SELECT id, version, definition FROM app.integrations")
  const byId = new Map<string, { version: number; definition: IntegrationDefinition }>(
    installed.rows.map(row => [row.id, { version: row.version, definition: row.definition }])
  )

  const entries: LibraryEntry[] = []
  for (const id of ids) {
    const definition = await loadLibraryEntry(libraryPath, id)
    if (!definition || definition.id !== id) continue
    const current = byId.get(id)
    entries.push({
      id,
      name: definition.name ?? { _base: "en", en: id },
      description: definition.description ?? null,
      source: definition.source ?? null,
      trigger: definition.trigger ?? {},
      runtime: definition.runtime,
      destinations: (definition.destinations ?? []).map(d =>
        d.kind === "table" ? { kind: "table", id: d.tableId } : { kind: "raster", id: d.layerId }
      ),
      status: !current
        ? "not_installed"
        : comparableJson(current.definition) === comparableJson(definition)
          ? "installed"
          : "update_available",
      installedVersion: current?.version ?? null
    })
  }
  return entries
}

/**
 * Installs or updates one entry. On update, the deployment-owned fields keep
 * their installed values (present, absent, or explicit null alike). Returns
 * null when the entry does not exist.
 */
export async function installLibraryEntry(
  pool: pg.Pool,
  libraryPath: string,
  id: string,
  createdBy: string | null
): Promise<{ version: number } | null> {
  const entry = await loadLibraryEntry(libraryPath, id)
  if (!entry || entry.id !== id) return null
  const installed = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [id])
  const definition: Record<string, unknown> = { ...entry }
  if (installed.rows.length > 0) {
    const current = installed.rows[0].definition as Record<string, unknown>
    for (const field of DEPLOYMENT_FIELDS) {
      if (field in current) definition[field] = current[field]
      else delete definition[field]
    }
    // Values for settings the entry no longer declares, or no longer accepts, fall back to its defaults
    const kept = keepValidSettingValues(
      current.settingValues as Record<string, SettingValue> | undefined,
      entry.settings
    )
    if (Object.keys(kept).length > 0) definition.settingValues = kept
    else delete definition.settingValues
  }
  return installIntegration(pool, definition as unknown as IntegrationDefinition, "ready", createdBy)
}

import { createHash } from "node:crypto"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { durationMs } from "./validation.js"
import { ensureTable, ident } from "./destinations.js"
import { ensureLayer } from "./catalog.js"
import { refreshLayerMasks } from "./aoi.js"
import { parseAoi } from "./settings.js"
import { parseCron } from "./cron.js"
import { validateDefinitionStrings } from "./localizeCatalog.js"
import { settingsProblems } from "./integrationSettings.js"
import { SECRET_NAME_PATTERN } from "./secrets.js"
import { deleteIntegrationFiles } from "./files.js"

/** Published-identifier rule for all definition-borne ids. */
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Extension rule for file slots' accept lists and stored file versions. */
export const FILE_EXT_PATTERN = /^\.[a-z0-9]{1,10}$/

/** Permitted ColumnSpec types; definitions arrive as untyped JSON. */
const COLUMN_TYPES = ["text", "number", "integer", "boolean", "date", "datetime", "geometry", "enum", "json"]

/**
 * Canonical form for definition identity: keys sorted recursively, and every
 * LocalizedString reduced to its base language text. Translations are display
 * metadata - filling or fixing them never changes what a definition IS, so
 * certification hashes and library update detection ignore them.
 */
export function canonicalDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDefinition)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record._base === "string" && typeof record[record._base] === "string") {
      return { _base: record._base, [record._base]: record[record._base] }
    }
    return Object.fromEntries(
      Object.keys(record).sort().map(k => [k, canonicalDefinition(record[k])])
    )
  }
  return value
}

/**
 * Stable content fingerprint of a definition (canonicalDefinition serialized).
 * Used only by design sessions to gate finish on a cold run of the exact
 * current definition; never stored in the database.
 */
export function definitionHash(definition: IntegrationDefinition): string {
  // Setting values are the deployment's to change; the code was certified against every valid value
  const { settingValues: _values, ...rest } = definition
  return createHash("sha256").update(JSON.stringify(canonicalDefinition(rest))).digest("hex")
}

/** Structural validation beyond what the types express. Throws on violations. */
export function validateDefinition(definition: IntegrationDefinition): void {
  const badId = (id: string) => !ID_PATTERN.test(id)
  if (badId(definition.id)) throw new Error(`Invalid integration id: ${definition.id}`)
  // Human-facing text must be LocalizedString-shaped; plain strings exist
  // only at the agent boundary and are wrapped before validation
  const stringProblems = validateDefinitionStrings(definition)
  if (stringProblems.length > 0) throw new Error(`Localized text problems: ${stringProblems.join("; ")}`)
  if (definition.contract !== 2) throw new Error("contract must be 2, the entrypoint contract this platform runs")
  if (definition.runtime !== "python" && definition.runtime !== "node") throw new Error('runtime must be "python" or "node"')
  // Tri-state AOI: explicit boxes must be well-formed (null and absent are meaningful)
  if (definition.aoi != null) parseAoi(definition.aoi)
  const settingProblems = settingsProblems(definition)
  if (settingProblems.length > 0) throw new Error(`Setting problems: ${settingProblems.join("; ")}`)
  if (definition.secrets !== undefined) {
    if (!Array.isArray(definition.secrets)) throw new Error("secrets must be an array of names")
    const seen = new Set<string>()
    for (const name of definition.secrets) {
      if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid secret name "${String(name)}": letters, digits and underscores, not starting with a digit`)
      }
      if (seen.has(name)) throw new Error(`Secret ${name} is declared twice`)
      seen.add(name)
    }
  }
  // The scheduler evaluates trigger.cron every minute; reject bad expressions here
  if (definition.trigger?.cron !== undefined) parseCron(definition.trigger.cron)
  const delay = definition.trigger?.webhookDelaySeconds
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > 86400)) {
    throw new Error("webhookDelaySeconds must be an integer between 0 and 86400")
  }
  if (definition.files !== undefined) {
    if (!definition.files || typeof definition.files !== "object" || Array.isArray(definition.files)) {
      throw new Error("files must be an object keyed by slot id")
    }
    for (const [slotId, slot] of Object.entries(definition.files)) {
      if (badId(slotId)) throw new Error(`Invalid file slot id: ${slotId} (lowercase snake_case)`)
      if (!slot || typeof slot !== "object") throw new Error(`File slot ${slotId} must be an object`)
      if (slot.accept !== undefined) {
        if (!Array.isArray(slot.accept) || slot.accept.length === 0) {
          throw new Error(`files.${slotId}.accept must be a non-empty list of extensions, or omitted to accept any`)
        }
        for (const ext of slot.accept) {
          if (typeof ext !== "string" || !FILE_EXT_PATTERN.test(ext)) {
            throw new Error(`Invalid extension "${String(ext)}" in files.${slotId}.accept: lowercase with the dot, e.g. ".xlsx"`)
          }
        }
      }
    }
  }
  const inputIds = new Set(Object.keys(definition.inputs ?? {}))
  for (const inputId of inputIds) {
    if (badId(inputId)) throw new Error(`Invalid input id: ${inputId}`)
  }
  for (const dest of definition.destinations) {
    if (dest.kind === "table") {
      if (badId(dest.tableId)) throw new Error(`Invalid tableId: ${dest.tableId}`)
      if (!["replace", "append", "merge"].includes(dest.action)) {
        throw new Error(`Invalid action "${dest.action}" in ${dest.tableId}: use replace, append, or merge`)
      }
      for (const c of dest.columns) {
        if (badId(c.id)) throw new Error(`Invalid column id: ${c.id} in ${dest.tableId}`)
        if (!COLUMN_TYPES.includes(c.type)) {
          throw new Error(`Invalid column type "${c.type}" for ${dest.tableId}.${c.id}: use ${COLUMN_TYPES.join(", ")}`)
        }
      }
      if (dest.action === "merge") {
        if (!dest.mergeColumns?.length) throw new Error(`Merge destination ${dest.tableId} requires mergeColumns`)
        const columnIds = new Set(dest.columns.map(c => c.id))
        for (const key of dest.mergeColumns) {
          if (!columnIds.has(key)) throw new Error(`mergeColumns entry "${key}" is not a column of ${dest.tableId}`)
        }
      }
    } else {
      if (badId(dest.layerId)) throw new Error(`Invalid layerId: ${dest.layerId}`)
      for (const b of dest.bands) {
        if (badId(b.id)) throw new Error(`Invalid band id: ${b.id} in ${dest.layerId}`)
      }
      if (dest.retention != null) {
        if (dest.temporality !== "time-series") {
          throw new Error(`retention on ${dest.layerId} needs temporality "time-series" (current-only keeps one snapshot)`)
        }
        const days = dest.retention.days
        if (!Number.isInteger(days) || days < 1) {
          throw new Error(`retention.days on ${dest.layerId} must be a whole number of days, at least 1`)
        }
      }
    }
    // A definition reading its own destination would re-trigger itself forever
    const destId = dest.kind === "table" ? dest.tableId : dest.layerId
    for (const input of Object.values(definition.inputs ?? {})) {
      const inputRef = input.kind === "table" ? input.tableId : input.layerId
      if (inputRef === destId) throw new Error(`Input references own destination: ${destId}`)
    }
  }
  if (definition.validation !== undefined) validateRules(definition)
}

/** The validation block: a known cadence and range rules naming real numeric columns or bands. */
function validateRules(definition: IntegrationDefinition): void {
  const validation = definition.validation
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    throw new Error("validation must be an object with expectedCadence and/or ranges")
  }
  const unknown = Object.keys(validation).filter(key => key !== "expectedCadence" && key !== "ranges")
  if (unknown.length > 0) throw new Error(`Unknown validation field(s): ${unknown.join(", ")} (use expectedCadence, ranges)`)
  if (validation.expectedCadence !== undefined && durationMs(validation.expectedCadence) === null) {
    throw new Error(`validation.expectedCadence "${validation.expectedCadence}" is not an ISO 8601 duration such as P1D or PT6H`)
  }
  for (const rule of validation.ranges ?? []) {
    const where = `validation range on ${rule.destinationId}.${rule.field}`
    if (rule.min === undefined && rule.max === undefined) throw new Error(`${where} needs min, max, or both`)
    for (const bound of [rule.min, rule.max]) {
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) throw new Error(`${where}: bounds must be numbers`)
    }
    const dest = definition.destinations.find(d => (d.kind === "table" ? d.tableId : d.layerId) === rule.destinationId)
    if (!dest) throw new Error(`${where}: no destination ${rule.destinationId}`)
    if (dest.kind === "table") {
      const column = dest.columns.find(c => c.id === rule.field)
      if (!column || (column.type !== "number" && column.type !== "integer")) {
        throw new Error(`${where}: ${rule.field} is not a number or integer column of ${rule.destinationId}`)
      }
    } else if (!dest.bands.some(b => b.id === rule.field)) {
      throw new Error(`${where}: ${rule.field} is not a band of ${rule.destinationId}`)
    }
  }
}

/** Lifecycle of an installed integration; design sessions only install certified definitions. */
export type IntegrationStatus = "draft" | "ready"

/**
 * Installs or updates an integration: bumps the version and archives the
 * definition when it changed (an unchanged definition keeps its version, so
 * library re-syncs are no-ops), updates the integration row, and ensures
 * destination tables and layers exist with this integration as their sole
 * owner. The definition is the integration's single specification; library
 * installs copy the entry's defaults into it and updates carry
 * deployment-owned fields over. Design sessions run in a
 * scratch area and call this only at finish, with a cold-run-certified
 * definition. createdBy is the installing user, or null for CLI installs;
 * enabledOnCreate sets a new row's scheduler switch (imports land paused).
 */
export async function installIntegration(
  pool: pg.Pool,
  definition: IntegrationDefinition,
  status: IntegrationStatus = "ready",
  createdBy: string | null = null,
  enabledOnCreate = true
): Promise<{ version: number }> {
  validateDefinition(definition)
  const definitionJson = JSON.stringify(definition)
  const client = await pool.connect()
  let version: number
  try {
    await client.query("BEGIN")
    // Lock the row so version assignment is serialized per integration.
    // Unchanged means equal to the archived current version, not to the row:
    // design sessions rewrite a draft's row in place without archiving
    const current = await client.query(
      `SELECT i.version, v.definition IS NOT DISTINCT FROM $2::jsonb AS unchanged
       FROM app.integrations i
       LEFT JOIN app.integration_versions v ON v.integration_id = i.id AND v.version = i.version
       WHERE i.id = $1 FOR UPDATE OF i`,
      [definition.id, definitionJson]
    )
    if (current.rows.length === 0) {
      version = 1
      await client.query(
        `INSERT INTO app.integrations (id, definition, version, status, enabled) VALUES ($1, $2, $3, $4, $5)`,
        [definition.id, definitionJson, version, status, enabledOnCreate]
      )
      await client.query(
        `INSERT INTO app.integration_versions (integration_id, version, definition, created_by)
         VALUES ($1, $2, $3, $4)`,
        [definition.id, version, definitionJson, createdBy]
      )
    } else if (current.rows[0].unchanged) {
      version = current.rows[0].version
      await client.query(`UPDATE app.integrations SET definition = $2, status = $3, updated_at = now() WHERE id = $1`, [
        definition.id,
        definitionJson,
        status
      ])
    } else {
      version = current.rows[0].version + 1
      await client.query(
        `UPDATE app.integrations SET definition = $2, version = $3, status = $4, updated_at = now() WHERE id = $1`,
        [definition.id, definitionJson, version, status]
      )
      await client.query(
        `INSERT INTO app.integration_versions (integration_id, version, definition, created_by)
         VALUES ($1, $2, $3, $4)`,
        [definition.id, version, definitionJson, createdBy]
      )
    }
    for (const dest of definition.destinations) {
      if (dest.kind === "table") {
        const owner = await client.query("SELECT integration_id FROM app.data_tables WHERE id = $1", [dest.tableId])
        if (owner.rows.length > 0 && owner.rows[0].integration_id !== definition.id) {
          throw new Error(`Table ${dest.tableId} is owned by ${owner.rows[0].integration_id}`)
        }
        await client.query(
          `INSERT INTO app.data_tables (id, integration_id, spec) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now()`,
          [dest.tableId, definition.id, JSON.stringify(dest)]
        )
        await ensureTable(client, dest)
      } else {
        await ensureLayer(client, definition.id, dest)
      }
    }
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  // The layers' map masks follow the definition's area; a missing boundary
  // must not fail an install
  await refreshLayerMasks(pool, definition.id).catch(err =>
    console.warn(`${definition.id}: layer masks not rebuilt: ${err instanceof Error ? err.message : err}`)
  )
  return { version }
}

/** What an integration owns, and who would break if it were deleted. */
export interface IntegrationUsage {
  /** Table ids owned via app.data_tables. */
  tables: string[]
  /** Raster layer ids owned (installed layers, not session scratch). */
  layers: string[]
  /** Installed integrations whose inputs read this one's tables or layers. */
  dependents: { id: string; via: string }[]
  /** Dashboards whose current version's queries mention an owned table or layer id. */
  dashboards: { id: string; name: string }[]
  /** Total recorded runs. */
  runs: number
}

/** Shape of a stored definition's inputs, as far as usage scanning cares. */
interface InputsShape {
  inputs?: Record<string, { kind?: string; tableId?: string; layerId?: string }>
}

/**
 * Reports what an integration owns and everything that would break with it:
 * derived integrations reading its destinations (hard dependencies) and
 * dashboards whose SQL mentions them (best-effort textual match).
 */
export async function integrationUsage(pool: pg.Pool, integrationId: string): Promise<IntegrationUsage> {
  const tables = await pool.query("SELECT id FROM app.data_tables WHERE integration_id = $1 ORDER BY id", [
    integrationId
  ])
  const layers = await pool.query(
    "SELECT id FROM app.raster_layers WHERE integration_id = $1 AND session_id IS NULL ORDER BY id",
    [integrationId]
  )
  const tableIds = new Set(tables.rows.map(r => r.id as string))
  const layerIds = new Set(layers.rows.map(r => r.id as string))

  const dependents: { id: string; via: string }[] = []
  const others = await pool.query("SELECT id, definition FROM app.integrations WHERE id <> $1 ORDER BY id", [
    integrationId
  ])
  for (const row of others.rows) {
    for (const input of Object.values((row.definition as InputsShape).inputs ?? {})) {
      const ref = input.kind === "table" ? input.tableId : input.kind === "raster" ? input.layerId : undefined
      const hit = input.kind === "table" ? tableIds.has(ref ?? "") : layerIds.has(ref ?? "")
      if (hit) dependents.push({ id: row.id as string, via: ref! })
    }
  }

  // Textual scan: table/layer ids are distinctive slugs, so a word match in the
  // stored SQL is a strong signal, though not proof
  const dashboards: { id: string; name: string }[] = []
  const allIds = [...tableIds, ...layerIds]
  if (allIds.length > 0) {
    const versions = await pool.query(
      `SELECT d.id, d.name, v.queries FROM app.dashboards d
       JOIN app.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.current_version
       ORDER BY d.id`
    )
    for (const row of versions.rows) {
      const sql = (row.queries as { sql?: string }[]).map(q => q.sql ?? "").join("\n")
      if (allIds.some(id => new RegExp(`\\b${id}\\b`).test(sql))) {
        dashboards.push({ id: row.id as string, name: row.name as string })
      }
    }
  }

  const runs = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE integration_id = $1", [integrationId])
  return {
    tables: [...tableIds],
    layers: [...layerIds],
    dependents,
    dashboards,
    runs: runs.rows[0].n as number
  }
}

/** What deleteIntegration removed, plus the files for the caller to clean up. */
export interface DeleteIntegrationResult {
  /** False when no such integration exists. */
  ok: boolean
  /** data.* tables dropped. */
  tables: number
  /** Raster snapshots deleted; their store files (every source) are in snapshotPaths. */
  snapshots: number
  /** Store-relative COG paths of the deleted snapshots (delete post-commit). */
  snapshotPaths: string[]
  /** Owned layer ids, for tile-cache cleanup. */
  layerIds: string[]
  /** Run rows deleted. */
  runs: number
  /** Design sessions kept, with their integration binding cleared. */
  sessions: number
  /** Uploaded file versions deleted; their store files are the caller's to remove. */
  files: { id: string; ext: string }[]
}

/**
 * Permanently deletes an integration and everything it owns: data tables and
 * their registry claims, raster layers with all snapshots (data.rasters rows
 * cascade), run history, webhook events, uploaded file versions, and the
 * definition archive. Design sessions survive with their binding cleared.
 * Refuses while a run is queued or running, and while another integration's
 * inputs depend on it — file cleanup (store COGs, uploaded files, tile cache,
 * /work) is the caller's, from the returned paths, after this commits.
 */
export async function deleteIntegration(pool: pg.Pool, integrationId: string): Promise<DeleteIntegrationResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const existing = await client.query("SELECT id FROM app.integrations WHERE id = $1 FOR UPDATE", [integrationId])
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK")
      return { ok: false, tables: 0, snapshots: 0, snapshotPaths: [], layerIds: [], runs: 0, sessions: 0, files: [] }
    }
    const active = await client.query(
      "SELECT 1 FROM app.runs WHERE integration_id = $1 AND status IN ('queued', 'running')",
      [integrationId]
    )
    if (active.rows.length > 0) {
      throw new Error(`Integration ${integrationId} has a queued or running run; stop it first`)
    }
    const usage = await integrationUsage(pool, integrationId)
    if (usage.dependents.length > 0) {
      const list = usage.dependents.map(d => `${d.id} (reads ${d.via})`).join(", ")
      throw new Error(`Integration ${integrationId} is a dependency of: ${list}. Delete or edit those first.`)
    }

    await client.query("DELETE FROM app.webhook_events WHERE integration_id = $1", [integrationId])
    // Sessions that designed it let go of the id too, so the name is free:
    // a resumed session names its draft again, and its file pins went with
    // the integration's versions
    const sessions = await client.query(
      `UPDATE app.agent_sessions
       SET client_state = jsonb_set(client_state, '{definition,id}', '""') - 'files' - 'filesNote'
       WHERE kind = 'designer' AND client_state->'definition'->>'id' = $1`,
      [integrationId]
    )

    for (const tableId of usage.tables) {
      await client.query(`DROP TABLE IF EXISTS data.${ident(tableId)}`)
    }
    await client.query("DELETE FROM app.data_tables WHERE integration_id = $1", [integrationId])

    const snapshots = await client.query(
      `SELECT s.id, (SELECT array_agg(src.path) FROM app.raster_sources src WHERE src.snapshot_id = s.id) AS paths
       FROM app.raster_snapshots s
       JOIN app.raster_layers l ON l.id = s.layer_id
       WHERE l.integration_id = $1 AND l.session_id IS NULL`,
      [integrationId]
    )
    await client.query(
      "UPDATE app.raster_layers SET current_snapshot_id = NULL WHERE integration_id = $1 AND session_id IS NULL",
      [integrationId]
    )
    // data.rasters rows cascade from the snapshot delete; snapshots reference
    // their producing run, so they go before the runs they pin
    await client.query(
      `DELETE FROM app.raster_snapshots s USING app.raster_layers l
       WHERE s.layer_id = l.id AND l.integration_id = $1 AND l.session_id IS NULL`,
      [integrationId]
    )
    await client.query("DELETE FROM app.raster_layers WHERE integration_id = $1 AND session_id IS NULL", [
      integrationId
    ])
    const runs = await client.query("DELETE FROM app.runs WHERE integration_id = $1", [integrationId])
    const files = await deleteIntegrationFiles(client, integrationId)

    // integrations_version_fk is INITIALLY DEFERRED, so the current pointer may
    // dangle until commit, by which point both sides are gone
    await client.query("DELETE FROM app.integration_versions WHERE integration_id = $1", [integrationId])
    await client.query("DELETE FROM app.integrations WHERE id = $1", [integrationId])
    await client.query("COMMIT")
    return {
      ok: true,
      tables: usage.tables.length,
      snapshots: snapshots.rows.length,
      snapshotPaths: snapshots.rows.flatMap(r => (r.paths as string[] | null) ?? []),
      layerIds: usage.layers,
      runs: runs.rowCount ?? 0,
      sessions: sessions.rowCount ?? 0,
      files
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

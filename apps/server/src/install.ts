import { createHash } from "node:crypto"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { ensureTable } from "./destinations.js"
import { ensureLayer } from "./catalog.js"

/** Published-identifier rule for all definition-borne ids. */
const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Permitted ColumnSpec types; definitions arrive as untyped JSON. */
const COLUMN_TYPES = ["text", "number", "integer", "boolean", "date", "datetime", "geometry", "enum", "json"]

/** Stable content hash of a definition (keys sorted recursively). */
export function definitionHash(definition: IntegrationDefinition): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])])
      )
    }
    return value
  }
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex")
}

/** Structural validation beyond what the types express. Throws on violations. */
export function validateDefinition(definition: IntegrationDefinition): void {
  const badId = (id: string) => !ID_PATTERN.test(id)
  if (badId(definition.id)) throw new Error(`Invalid integration id: ${definition.id}`)
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
    }
    // A definition reading its own destination would re-trigger itself forever
    const destId = dest.kind === "table" ? dest.tableId : dest.layerId
    for (const input of Object.values(definition.inputs ?? {})) {
      const inputRef = input.kind === "table" ? input.tableId : input.layerId
      if (inputRef === destId) throw new Error(`Input references own destination: ${destId}`)
    }
  }
}

/**
 * Installs or updates an integration: records the definition revision, upserts
 * the integration row, and ensures destination tables and layers exist with
 * this integration as their sole owner.
 */
export async function installIntegration(
  pool: pg.Pool,
  definition: IntegrationDefinition,
  overrides: Record<string, unknown> = {}
): Promise<{ hash: string }> {
  validateDefinition(definition)
  const hash = definitionHash(definition)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "INSERT INTO app.definition_revisions (hash, definition) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING",
      [hash, JSON.stringify(definition)]
    )
    await client.query(
      `INSERT INTO app.integrations (id, definition, definition_hash, overrides)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         definition = EXCLUDED.definition,
         definition_hash = EXCLUDED.definition_hash,
         overrides = EXCLUDED.overrides,
         updated_at = now()`,
      [definition.id, JSON.stringify(definition), hash, JSON.stringify(overrides)]
    )
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
    return { hash }
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

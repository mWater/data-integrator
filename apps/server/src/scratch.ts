import { rm } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { RasterStore } from "./rasterStore.js"

/** Session id reduced to a schema-safe hex token. */
function sessionToken(sessionId: string): string {
  const token = sessionId.replace(/[^0-9a-f]/g, "")
  if (token.length === 0) throw new Error(`Invalid session id: ${sessionId}`)
  return token
}

/** Postgres schema holding a session's scratch destination tables. */
export function draftSchema(sessionId: string): string {
  return `draft_${sessionToken(sessionId)}`
}

/**
 * Creates a session's draft schema, readable by sql_engine: the designer's
 * query_table reads scratch tables under that role, never as the app.
 */
export async function createDraftSchema(client: pg.ClientBase | pg.Pool, sessionId: string): Promise<void> {
  const schema = draftSchema(sessionId)
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO sql_engine`)
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO sql_engine`)
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO sql_engine`)
}

/** raster_layers row id for a session's preview of a declared layer. */
export function scratchLayerId(sessionId: string, layerId: string): string {
  return `draft_${sessionToken(sessionId)}_${layerId}`
}

/** /work directory name for a session's scratch runs and snippets. */
export function scratchWorkDir(workRoot: string, sessionId: string): string {
  return path.join(workRoot, `session-${sessionToken(sessionId)}`)
}

/**
 * Removes a session's scratch area: draft schema, preview layers and their
 * snapshots plus stored files, and the session /work directory. Scratch run
 * rows are kept as session history. Safe to call when nothing exists.
 */
export async function cleanupScratch(
  pool: pg.Pool | pg.PoolClient,
  store: RasterStore,
  workRoot: string,
  sessionId: string
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${draftSchema(sessionId)} CASCADE`)
  // Remove each preview layer's whole store directory, not just row-referenced
  // files: failed runs can leave artifacts no snapshot row points to.
  const layers = await pool.query("SELECT id FROM app.raster_layers WHERE session_id = $1", [sessionId])
  for (const row of layers.rows) {
    await rm(store.absolute(row.id), { recursive: true, force: true })
  }
  await pool.query("UPDATE app.raster_layers SET current_snapshot_id = NULL WHERE session_id = $1", [sessionId])
  await pool.query(
    `DELETE FROM app.raster_snapshots s USING app.raster_layers l
     WHERE s.layer_id = l.id AND l.session_id = $1`,
    [sessionId]
  )
  await pool.query("DELETE FROM app.raster_layers WHERE session_id = $1", [sessionId])
  await rm(scratchWorkDir(workRoot, sessionId), { recursive: true, force: true })
}

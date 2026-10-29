/**
 * Integration files (docs/Integration Files.md): versions per declared slot, which
 * version a run reads, and the current pointer a successful production run
 * moves. A run reads, per declared slot, its pin, else the slot's current
 * version, else nothing, in which case it is refused before it starts. There
 * is no "latest upload" fallback: every path that introduces a version pins it.
 */

import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { InManifestFile, IntegrationDefinition } from "@data-integrator/definitions"
import { FileStore, StagedUpload } from "./fileStore.js"

/** One uploaded file version as the server sees it. */
export interface FileVersion {
  /** Version id; also the stored file's name */
  id: string
  /** Owning integration; null while a design session's upload awaits adoption */
  integrationId: string | null
  /** Design session it was attached in, if any */
  sessionId: string | null
  /** Slot it was uploaded to */
  slotId: string
  /** Number within the slot, from 1 */
  version: number
  /** Name it was uploaded under; display only, may carry personal data */
  filename: string
  /** Validated lowercase extension with the dot, or "" */
  ext: string
  /** SHA-256 of the contents, hex */
  sha256: string
  /** Size in bytes */
  sizeBytes: number
  /** Uploading user; null for CLI uploads */
  uploadedBy: string | null
  /** Upload time (ISO) */
  uploadedAt: string
  /** When an admin purged the bytes (ISO); null while live */
  purgedAt: string | null
}

/** A run cannot start: a declared slot has no pinned and no current version. */
export class AwaitingFileError extends Error {
  /** The slot with nothing to read */
  readonly slotId: string

  /** Creates the error for one slot. */
  constructor(slotId: string, hint = "") {
    super(`Awaiting file upload for slot ${slotId}${hint}`)
    this.slotId = slotId
  }
}

/** Columns selected wherever a FileVersion is built. */
const VERSION_COLUMNS = `id, integration_id, session_id, slot_id, version, filename, ext, sha256, size_bytes,
  uploaded_by, uploaded_at, purged_at`

/** Maps a file_versions row to a FileVersion. */
function toVersion(row: Record<string, unknown>): FileVersion {
  return {
    id: row.id as string,
    integrationId: (row.integration_id as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    slotId: row.slot_id as string,
    version: row.version as number,
    filename: row.filename as string,
    ext: row.ext as string,
    sha256: row.sha256 as string,
    sizeBytes: Number(row.size_bytes),
    uploadedBy: (row.uploaded_by as string | null) ?? null,
    uploadedAt: (row.uploaded_at as Date).toISOString(),
    purgedAt: row.purged_at ? (row.purged_at as Date).toISOString() : null
  }
}

/** Who a new version belongs to: the integration, or a session until its draft row exists. */
export interface VersionOwner {
  /** Owning integration, when its row exists */
  integrationId: string | null
  /** Design session the upload came from */
  sessionId: string | null
}

/**
 * Records a staged upload as the next version of its slot: numbers it under a
 * per-slot lock, inserts the row, and renames the bytes into place inside the
 * same transaction, so a row never exists without its file. A failed commit
 * after the rename leaves a version-named orphan that boot cleanup removes.
 */
export async function recordVersion(
  pool: pg.Pool,
  store: FileStore,
  staged: StagedUpload,
  owner: VersionOwner,
  upload: { slotId: string; filename: string; ext: string; uploadedBy: string | null }
): Promise<FileVersion> {
  if (!owner.integrationId && !owner.sessionId) throw new Error("A file version needs an integration or a session")
  const client = await pool.connect()
  let finalPath: string | null = null
  try {
    await client.query("BEGIN")
    const ownerKey = owner.integrationId ? `integration:${owner.integrationId}` : `session:${owner.sessionId}`
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-version:${ownerKey}:${upload.slotId}`])
    const inserted = await client.query(
      `INSERT INTO app.file_versions
         (integration_id, session_id, slot_id, version, filename, ext, sha256, size_bytes, uploaded_by)
       SELECT $1::text, $2::uuid, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, $7, $8
       FROM app.file_versions
       WHERE slot_id = $3
         AND (CASE WHEN $1::text IS NOT NULL THEN integration_id = $1::text
                   ELSE integration_id IS NULL AND session_id = $2::uuid END)
       RETURNING ${VERSION_COLUMNS}`,
      [
        owner.integrationId,
        owner.sessionId,
        upload.slotId,
        upload.filename,
        upload.ext,
        staged.sha256,
        staged.sizeBytes,
        upload.uploadedBy
      ]
    )
    const version = toVersion(inserted.rows[0])
    finalPath = store.versionPath(version.id, version.ext)
    await rename(staged.tmpPath, finalPath)
    await client.query("COMMIT")
    return version
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    await rm(staged.tmpPath, { force: true })
    if (finalPath) await rm(finalPath, { force: true })
    throw err
  } finally {
    client.release()
  }
}

/** One version by id, or null. */
export async function getVersion(pool: pg.Pool, versionId: string): Promise<FileVersion | null> {
  if (!/^[0-9a-f-]{36}$/.test(versionId)) return null
  const result = await pool.query(`SELECT ${VERSION_COLUMNS} FROM app.file_versions WHERE id = $1`, [versionId])
  return result.rows.length > 0 ? toVersion(result.rows[0]) : null
}

/** Current version per slot of an integration. */
export async function currentVersions(pool: pg.Pool | pg.PoolClient, integrationId: string): Promise<Record<string, FileVersion>> {
  const result = await pool.query(
    `SELECT ${VERSION_COLUMNS.split(",").map(c => `v.${c.trim()}`).join(", ")}
     FROM app.file_slots s JOIN app.file_versions v ON v.id = s.current_version_id
     WHERE s.integration_id = $1`,
    [integrationId]
  )
  return Object.fromEntries(result.rows.map(row => [row.slot_id as string, toVersion(row)]))
}

/** Refusal message when a version's extension is not on its slot's accept list; null when accepted. */
export function acceptProblem(definition: IntegrationDefinition, slotId: string, ext: string): string | null {
  const accept = definition.files?.[slotId]?.accept
  if (!accept || accept.includes(ext)) return null
  return `Slot ${slotId} accepts ${accept.join(", ")}; got ${ext === "" ? "a file with no extension" : ext}`
}

/** What a run or snippet reads: one version per slot. */
export type ResolvedFiles = Record<string, FileVersion>

/** Inputs to resolveFiles. */
export interface ResolveOptions {
  /** Integration whose current versions fill unpinned slots, and which may own pinned versions */
  integrationId: string
  /** The definition being run (the draft, in a design session) */
  definition: IntegrationDefinition
  /** Versions pinned per slot */
  pins?: Record<string, string> | null
  /** Design session whose own uploads may also be pinned */
  sessionId?: string | null
  /** Snippets: pinned slots the definition does not declare yet are read too, without the accept check */
  includeUndeclaredPins?: boolean
  /** Appended to the awaiting-upload refusal, e.g. what to do about it */
  awaitingHint?: string
  /** Snippets: a declared slot with nothing to read is left out instead of refusing */
  skipMissing?: boolean
}

/**
 * Resolves the version each slot reads: its pin, else current, else the run
 * is refused with AwaitingFileError. A pin must name a live version of that
 * slot owned by the integration (or the given session) and, for a declared
 * slot, match the accept list, since pinned versions are often staged with
 * the type check skipped.
 */
export async function resolveFiles(pool: pg.Pool, options: ResolveOptions): Promise<ResolvedFiles> {
  const { integrationId, definition } = options
  const pins = options.pins ?? {}
  const declared = definition.files ?? {}
  const current = await currentVersions(pool, integrationId)
  const resolved: ResolvedFiles = {}

  for (const [slotId, versionId] of Object.entries(pins)) {
    if (!(slotId in declared) && !options.includeUndeclaredPins) {
      throw new Error(`File slot ${slotId} is not declared by ${integrationId}`)
    }
    const version = typeof versionId === "string" ? await getVersion(pool, versionId) : null
    const owned =
      version !== null &&
      (version.integrationId === integrationId || (options.sessionId != null && version.sessionId === options.sessionId))
    if (!version || !owned || version.slotId !== slotId) {
      throw new Error(`No file version ${String(versionId)} in slot ${slotId} of ${integrationId}`)
    }
    if (version.purgedAt) throw new Error(`v${version.version} of slot ${slotId} was purged and cannot be read`)
    if (slotId in declared) {
      const problem = acceptProblem(definition, slotId, version.ext)
      if (problem) throw new Error(problem)
    }
    resolved[slotId] = version
  }
  for (const slotId of Object.keys(declared)) {
    if (resolved[slotId]) continue
    const fallback = current[slotId]
    if (!fallback || fallback.purgedAt) {
      if (options.skipMissing) continue
      if (options.awaitingHint !== undefined) throw new AwaitingFileError(slotId, options.awaitingHint)
      // Uploads staged without a run do not count: say how to use them
      const staged = await pool.query(
        "SELECT 1 FROM app.file_versions WHERE integration_id = $1 AND slot_id = $2 AND purged_at IS NULL LIMIT 1",
        [integrationId, slotId]
      )
      throw new AwaitingFileError(
        slotId,
        staged.rows.length > 0
          ? " (its uploads have not been read by a successful run yet; run one together with the other files, pinning both)"
          : ""
      )
    }
    resolved[slotId] = fallback
  }
  return resolved
}

/** First declared slot with no current version, or null when every slot can be read unpinned. */
export async function missingFileSlot(
  pool: pg.Pool,
  integrationId: string,
  definition: IntegrationDefinition
): Promise<string | null> {
  const slots = Object.keys(definition.files ?? {})
  if (slots.length === 0) return null
  const current = await currentVersions(pool, integrationId)
  return slots.find(slotId => !current[slotId] || current[slotId].purgedAt) ?? null
}

/**
 * Links resolved versions into <inDir>/files/<slotId><ext> and returns their
 * manifest entries, which the run also records as lineage.
 */
export async function materializeFiles(
  store: FileStore,
  inDir: string,
  files: ResolvedFiles
): Promise<Record<string, InManifestFile>> {
  const manifest: Record<string, InManifestFile> = {}
  const entries = Object.entries(files)
  if (entries.length === 0) return manifest
  await mkdir(path.join(inDir, "files"), { recursive: true })
  for (const [slotId, version] of entries) {
    const relPath = `files/${slotId}${version.ext}`
    await store.linkVersion(version.id, version.ext, path.join(inDir, relPath))
    manifest[slotId] = {
      path: relPath,
      versionId: version.id,
      version: version.version,
      filename: version.filename,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      uploadedAt: version.uploadedAt
    }
  }
  return manifest
}

/**
 * Makes the versions a successful production run read current for their
 * slots. Called inside the run's success commit, so current always matches
 * what the destination tables hold.
 */
export async function setCurrentVersions(
  client: pg.PoolClient,
  integrationId: string,
  files: Record<string, InManifestFile>
): Promise<void> {
  for (const [slotId, file] of Object.entries(files)) {
    await client.query(
      `INSERT INTO app.file_slots (integration_id, slot_id, current_version_id) VALUES ($1, $2, $3)
       ON CONFLICT (integration_id, slot_id) DO UPDATE SET current_version_id = EXCLUDED.current_version_id, updated_at = now()`,
      [integrationId, slotId, file.versionId]
    )
  }
}

/**
 * Hands a design session's unowned uploads to the integration whose draft row
 * now exists, renumbering each after the slot's existing versions (normally
 * none: the row was just created). Bytes stay where they are, keyed by id.
 */
export async function adoptSessionFiles(pool: pg.Pool, sessionId: string, integrationId: string): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const pending = await client.query(
      `SELECT id, slot_id FROM app.file_versions
       WHERE session_id = $1 AND integration_id IS NULL ORDER BY slot_id, version`,
      [sessionId]
    )
    for (const row of pending.rows) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `file-version:integration:${integrationId}:${row.slot_id}`
      ])
      await client.query(
        `UPDATE app.file_versions SET integration_id = $2,
           version = (SELECT COALESCE(MAX(version), 0) + 1 FROM app.file_versions WHERE integration_id = $2 AND slot_id = $3)
         WHERE id = $1`,
        [row.id, integrationId, row.slot_id]
      )
    }
    await client.query("COMMIT")
    return pending.rows.length
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** One version as the files API lists it; filename and uploader are null for viewers. */
export interface VersionListing {
  /** Version id */
  id: string
  /** Number within the slot */
  version: number
  /** Uploaded filename; null when redacted for a viewer */
  filename: string | null
  /** Uploader email; null when redacted, unknown, or a CLI upload */
  uploadedBy: string | null
  /** Upload time (ISO) */
  uploadedAt: string
  /** Size in bytes */
  sizeBytes: number
  /** SHA-256, hex */
  sha256: string
  /** True for the slot's current version */
  current: boolean
  /** Purge time (ISO) when purged */
  purgedAt: string | null
  /** Runs that read this version, newest first (bounded) */
  runs: { id: string; status: string; finishedAt: string | null }[]
}

/** One slot as the files API lists it. */
export interface SlotListing {
  /** Slot id */
  slotId: string
  /** True when the installed definition declares it; old slots keep their history */
  declared: boolean
  /** Declared description */
  description: unknown
  /** Declared accept list */
  accept: string[] | null
  /** Bytes held by live versions */
  bytesStored: number
  /** Versions, newest first */
  versions: VersionListing[]
}

/** Runs scanned per integration for "which runs used each version". */
const LINEAGE_RUN_LIMIT = 500

/**
 * Every slot of an integration with its versions and the runs that read each.
 * redact drops filenames and uploader emails, which can carry personal data.
 */
export async function listFiles(
  pool: pg.Pool,
  integrationId: string,
  definition: IntegrationDefinition,
  options: { redact: boolean }
): Promise<SlotListing[]> {
  const versions = await pool.query(
    `SELECT ${VERSION_COLUMNS.split(",").map(c => `v.${c.trim()}`).join(", ")}, u.email AS uploader_email,
            s.current_version_id = v.id AS is_current
     FROM app.file_versions v
     LEFT JOIN app.users u ON u.id = v.uploaded_by
     LEFT JOIN app.file_slots s ON s.integration_id = v.integration_id AND s.slot_id = v.slot_id
     WHERE v.integration_id = $1
     ORDER BY v.slot_id, v.version DESC`,
    [integrationId]
  )
  const runs = await pool.query(
    `SELECT id, status, finished_at, inputs->'files' AS files FROM app.runs
     WHERE integration_id = $1 AND inputs ? 'files' ORDER BY scheduled_at DESC LIMIT $2`,
    [integrationId, LINEAGE_RUN_LIMIT]
  )
  const runsByVersion = new Map<string, VersionListing["runs"]>()
  for (const run of runs.rows) {
    for (const file of Object.values((run.files ?? {}) as Record<string, InManifestFile>)) {
      const list = runsByVersion.get(file.versionId) ?? []
      list.push({ id: run.id, status: run.status, finishedAt: run.finished_at ? run.finished_at.toISOString() : null })
      runsByVersion.set(file.versionId, list)
    }
  }

  const slots = new Map<string, SlotListing>()
  const slotFor = (slotId: string): SlotListing => {
    let slot = slots.get(slotId)
    if (!slot) {
      const spec = definition.files?.[slotId]
      slot = {
        slotId,
        declared: spec !== undefined,
        description: spec?.description ?? null,
        accept: spec?.accept ?? null,
        bytesStored: 0,
        versions: []
      }
      slots.set(slotId, slot)
    }
    return slot
  }
  for (const slotId of Object.keys(definition.files ?? {})) slotFor(slotId)
  for (const row of versions.rows) {
    const version = toVersion(row)
    const slot = slotFor(version.slotId)
    if (!version.purgedAt) slot.bytesStored += version.sizeBytes
    slot.versions.push({
      id: version.id,
      version: version.version,
      filename: options.redact ? null : version.filename,
      uploadedBy: options.redact ? null : (row.uploader_email ?? null),
      uploadedAt: version.uploadedAt,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      current: row.is_current === true,
      purgedAt: version.purgedAt,
      runs: (runsByVersion.get(version.id) ?? []).slice(0, 20)
    })
  }
  return [...slots.values()]
}

/**
 * Purges one version's bytes for mistakes (personal data uploaded in error).
 * Refuses the current version of any slot and any version a queued or
 * running run pins or reads. The row stays, with its sha256, so lineage
 * still resolves; purged versions can no longer be pinned or downloaded.
 */
export async function purgeVersion(pool: pg.Pool, store: FileStore, versionId: string, by: string): Promise<FileVersion> {
  const client = await pool.connect()
  let purged: FileVersion
  try {
    await client.query("BEGIN")
    const found = await client.query(`SELECT ${VERSION_COLUMNS} FROM app.file_versions WHERE id = $1 FOR UPDATE`, [
      versionId
    ])
    if (found.rows.length === 0) throw new Error(`No file version ${versionId}`)
    const version = toVersion(found.rows[0])
    if (version.purgedAt) throw new Error(`v${version.version} of slot ${version.slotId} is already purged`)
    const current = await client.query("SELECT integration_id, slot_id FROM app.file_slots WHERE current_version_id = $1", [
      versionId
    ])
    if (current.rows.length > 0) {
      throw new Error(
        `v${version.version} is the current version of slot ${version.slotId}; upload and run a replacement first`
      )
    }
    // A run that pins it after this commits fails its pin validation instead
    const busy = await client.query(
      `SELECT id, status FROM app.runs
       WHERE status IN ('queued', 'running')
         AND (EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(file_pins, '{}')) p WHERE p.value = $1)
              OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(inputs->'files', '{}')) f WHERE f.value->>'versionId' = $1))`,
      [versionId]
    )
    if (busy.rows.length > 0) {
      throw new Error(`A ${busy.rows[0].status} run (${busy.rows[0].id}) uses v${version.version}; try again when it finishes`)
    }
    const updated = await client.query(
      `UPDATE app.file_versions SET purged_at = now(), purged_by = $2 WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
      [versionId, by]
    )
    purged = toVersion(updated.rows[0])
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
  // After the commit: a crash here leaves a version-named file with no live
  // row, which boot cleanup removes
  await store.deleteVersion(purged.id, purged.ext)
  return purged
}

/**
 * Deletes an integration's file rows inside deleteIntegration's transaction
 * and returns the stored files for the caller to remove after it commits.
 */
export async function deleteIntegrationFiles(
  client: pg.PoolClient,
  integrationId: string
): Promise<{ id: string; ext: string }[]> {
  await client.query("DELETE FROM app.file_slots WHERE integration_id = $1", [integrationId])
  const deleted = await client.query("DELETE FROM app.file_versions WHERE integration_id = $1 RETURNING id, ext", [
    integrationId
  ])
  return deleted.rows.map(row => ({ id: row.id as string, ext: row.ext as string }))
}

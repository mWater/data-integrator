/**
 * HTTP routes for integration files (docs/Integration Files.md): raw-body uploads,
 * the per-slot listing, downloads, and design-session staging uploads. Every
 * upload check runs before the body is read, and a client that sent
 * `Expect: 100-continue` is only told to continue once they pass, so a
 * refused upload is never transmitted. Bodies stream to the file store while
 * hashing; the host never parses them.
 */

import { IncomingMessage, ServerResponse } from "node:http"
import { rm } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { AuthUser } from "./auth.js"
import { DiskFullError, FileStore, fileExtension, UploadTooLargeError } from "./fileStore.js"
import { acceptProblem, FileVersion, getVersion, listFiles, recordVersion, VersionOwner } from "./files.js"
import { json, sendFile } from "./http.js"
import { ID_PATTERN } from "./install.js"
import { PinnedRunStart, RunRequestError, RunService } from "./runService.js"

/** What the file routes need from the host. */
export interface FileApiOptions {
  /** Where versions are stored */
  store: FileStore
  /** FILE_UPLOAD_MAX_MB */
  maxUploadMb: number
}

/** Upload routes: the only requests whose `Expect: 100-continue` waits for the checks. */
export const UPLOAD_PATH = /^\/api\/(?:integrations\/[a-z][a-z0-9_]*|sessions\/[0-9a-f-]+)\/files\/[^/]+$/

/** Whole-request deadline for the server: large uploads on slow links outlast the five minute default. */
export const REQUEST_DEADLINE_MS = 60 * 60 * 1000

/** Node's five minute whole-request default, which every request but an upload is still held to. */
const OTHER_REQUEST_DEADLINE_MS = 5 * 60 * 1000

/**
 * Holds a request that is not an upload to the five minute default, since
 * the server-wide deadline is the upload one: a request whose body is still
 * arriving by then has its connection dropped.
 */
export function limitRequestTime(req: IncomingMessage, res: ServerResponse, deadlineMs = OTHER_REQUEST_DEADLINE_MS): void {
  const timer = setTimeout(() => {
    if (!req.complete) req.socket.destroy()
  }, deadlineMs)
  timer.unref()
  req.once("end", () => clearTimeout(timer))
  res.once("close", () => clearTimeout(timer))
}

/** An upload whose connection goes this long without bytes is dropped. */
const UPLOAD_IDLE_MS = 2 * 60 * 1000

/** Longest filename kept for display. */
const FILENAME_MAX = 255

/** Requests whose client is waiting for 100 Continue before sending the body. */
const awaitingContinue = new WeakSet<IncomingMessage>()

/** Marks a request as waiting for 100 Continue, which the upload handler sends after its checks. */
export function deferContinue(req: IncomingMessage): void {
  awaitingContinue.add(req)
}

/**
 * Answers an upload without reading its body. The connection closes after
 * the answer, so an unread body is never parsed as the next request.
 */
function refuse(res: ServerResponse, status: number, error: string): void {
  res.setHeader("connection", "close")
  json(res, status, { error })
}

/** Display filename from the query: the last path component, without control characters, trimmed and bounded. */
function displayFilename(raw: string | null): string | null {
  const name = path.basename((raw ?? "").replace(/\\/g, "/").replace(/[\u0000-\u001f\u007f]/g, "")).trim()
  if (name === "" || name === "." || name === "..") return null
  if (name.length <= FILENAME_MAX) return name
  // Shorten the stem, never the extension: it decides the stored path and the type check
  const ext = path.extname(name)
  return ext.length < FILENAME_MAX ? name.slice(0, FILENAME_MAX - ext.length) + ext : name.slice(0, FILENAME_MAX)
}

/** One version as upload and listing responses carry it. */
function versionJson(version: FileVersion): Record<string, unknown> {
  return {
    id: version.id,
    slotId: version.slotId,
    version: version.version,
    filename: version.filename,
    sizeBytes: version.sizeBytes,
    sha256: version.sha256,
    uploadedAt: version.uploadedAt
  }
}

/**
 * Streams the body into the store and records it as the next version. Sends
 * the deferred 100 Continue first. The owner is resolved once the bytes are
 * in, since a large upload can outlast a change of ownership (a design
 * session's draft row appearing). Returns null when the upload failed and
 * has been answered (413, 507) or cannot be (the client went away); the
 * partial file is gone either way.
 */
async function receive(
  pool: pg.Pool,
  options: FileApiOptions,
  req: IncomingMessage,
  res: ServerResponse,
  owner: VersionOwner | (() => Promise<VersionOwner>),
  upload: { slotId: string; filename: string; ext: string; uploadedBy: string }
): Promise<FileVersion | null> {
  if (awaitingContinue.has(req)) res.writeContinue()
  req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(new Error("Upload idle for two minutes")))
  let staged
  try {
    staged = await options.store.stage(req, options.maxUploadMb * 1024 * 1024)
  } catch (err) {
    if (err instanceof UploadTooLargeError) refuse(res, 413, err.message)
    else if (err instanceof DiskFullError) refuse(res, 507, err.message)
    else res.destroy()
    return null
  } finally {
    req.setTimeout(0)
  }
  try {
    return await recordVersion(pool, options.store, staged, typeof owner === "function" ? await owner() : owner, upload)
  } catch (err) {
    await rm(staged.tmpPath, { force: true })
    throw err
  }
}

/** Validated upload query: the display filename and its extension, or the refusal already sent. */
function uploadTarget(res: ServerResponse, slotId: string, params: URLSearchParams): { filename: string; ext: string } | null {
  if (!ID_PATTERN.test(slotId)) {
    refuse(res, 400, `Invalid file slot id: ${slotId} (lowercase snake_case)`)
    return null
  }
  const filename = displayFilename(params.get("filename"))
  if (!filename) {
    refuse(res, 400, "filename is required (?filename=<name as uploaded>)")
    return null
  }
  try {
    return { filename, ext: fileExtension(filename) }
  } catch (err) {
    refuse(res, 400, err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * PUT /api/integrations/:id/files/:slot?filename=&run=true|false. run=true
 * (the default) requires an installed integration declaring the slot and
 * accepting the extension, then starts or queues a run pinning the new
 * version. run=false stages the version (multi-slot replace) and skips the
 * type check.
 */
async function handleIntegrationUpload(
  pool: pg.Pool,
  options: FileApiOptions,
  runs: RunService | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  integrationId: string,
  slotId: string,
  params: URLSearchParams
): Promise<void> {
  if (user.role === "viewer") return refuse(res, 403, "Viewers cannot upload files")
  const target = uploadTarget(res, slotId, params)
  if (!target) return
  const runParam = params.get("run") ?? "true"
  if (runParam !== "true" && runParam !== "false") return refuse(res, 400, "run must be true or false")
  const row = await pool.query("SELECT status, definition FROM app.integrations WHERE id = $1", [integrationId])
  if (row.rows.length === 0) return refuse(res, 404, "unknown integration")
  const definition = row.rows[0].definition as IntegrationDefinition
  const run = runParam === "true"
  if (run) {
    if (row.rows[0].status !== "ready") {
      return refuse(res, 409, `Integration ${integrationId} is a draft; upload with run=false or finish its design session`)
    }
    if (!definition.files?.[slotId]) return refuse(res, 400, `${integrationId} declares no file slot ${slotId}`)
    const problem = acceptProblem(definition, slotId, target.ext)
    if (problem) return refuse(res, 400, problem)
  }

  const version = await receive(pool, options, req, res, { integrationId, sessionId: null }, {
    slotId,
    ...target,
    uploadedBy: user.id
  })
  if (!version) return

  let started: PinnedRunStart | null = null
  let runError: string | undefined
  if (run) {
    if (!runs) runError = "No job runner configured on this server"
    else {
      try {
        started = await runs.startPinned(integrationId, { [slotId]: version.id })
      } catch (err) {
        // The version stands either way; the caller can run it once the cause is fixed
        runError = err instanceof Error ? err.message : String(err)
      }
    }
  }
  json(res, 201, {
    version: versionJson(version),
    run: started ? { id: started.runId, status: started.status } : null,
    ...(runError ? { runError } : {})
  })
}

/**
 * PUT /api/sessions/:id/files/:slot?filename=: a design session's
 * attachment. Owned by the session's integration once its draft row exists,
 * by the session alone before that (adopted when the row is created). Never
 * runs anything and skips the type check: the session may be changing the
 * accepted format.
 */
export async function handleSessionUpload(
  pool: pg.Pool,
  options: FileApiOptions | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  slotId: string,
  params: URLSearchParams
): Promise<void> {
  if (user.role === "viewer") return refuse(res, 403, "Viewers cannot run design sessions")
  if (!options) return refuse(res, 503, "No file store configured on this server")
  const target = uploadTarget(res, slotId, params)
  if (!target) return
  const owner = async (): Promise<VersionOwner> => {
    const session = await pool.query(
      `SELECT s.kind, i.id AS integration_id
       FROM app.agent_sessions s
       LEFT JOIN app.integrations i ON i.id = NULLIF(s.client_state->'definition'->>'id', '')
       WHERE s.id = $1`,
      [sessionId]
    )
    return { integrationId: session.rows[0]?.integration_id ?? null, sessionId }
  }
  const kind = await pool.query("SELECT kind FROM app.agent_sessions WHERE id = $1", [sessionId])
  if (kind.rows.length === 0) return refuse(res, 404, "unknown session")
  if (kind.rows[0].kind !== "designer") return refuse(res, 400, "Only integration design sessions take files")
  const version = await receive(pool, options, req, res, owner, { slotId, ...target, uploadedBy: user.id })
  if (version) json(res, 201, { version: versionJson(version) })
}

/** Attachment Content-Disposition: an ASCII fallback plus the RFC 5987 UTF-8 name. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Matches /api/integrations/:id/files and its subresources. */
const FILES_PATH =
  /^\/api\/integrations\/([a-z][a-z0-9_]*)\/files(?:\/([^/]+)(?:\/versions\/([0-9a-f-]{36})\/download)?)?$/

/**
 * The /api/integrations/:id/files routes. Returns false when the path is not
 * one of them. options null means no file store on this host (503).
 */
export async function routeIntegrationFiles(
  pool: pg.Pool,
  options: FileApiOptions | null,
  runs: RunService | null,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  params: URLSearchParams
): Promise<boolean> {
  const match = pathname.match(FILES_PATH)
  if (!match) return false
  const [, integrationId, slotId, versionId] = match
  if (!options) {
    refuse(res, 503, "No file store configured on this server")
    return true
  }

  if (slotId !== undefined && versionId === undefined && req.method === "PUT") {
    await handleIntegrationUpload(pool, options, runs, user, req, res, integrationId, slotId, params)
    return true
  }

  if (slotId === undefined && req.method === "GET") {
    const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [integrationId])
    if (row.rows.length === 0) json(res, 404, { error: "unknown integration" })
    else {
      // Filenames and uploader emails can carry personal data
      const slots = await listFiles(pool, integrationId, row.rows[0].definition, { redact: user.role === "viewer" })
      // The limit lets the page refuse an oversize file before sending it
      json(res, 200, { slots, maxUploadMb: options.maxUploadMb })
    }
    return true
  }

  if (versionId !== undefined && req.method === "GET") {
    if (user.role === "viewer") {
      json(res, 403, { error: "Viewers cannot download uploaded files" })
      return true
    }
    const version = await getVersion(pool, versionId)
    if (!version || version.integrationId !== integrationId || version.slotId !== slotId) {
      json(res, 404, { error: "unknown file version" })
      return true
    }
    if (version.purgedAt) {
      json(res, 410, { error: `v${version.version} was purged` })
      return true
    }
    // Opaque bytes, never rendered on the app's origin: uploaded HTML or SVG
    // must not run as this site
    const sent = await sendFile(res, options.store.versionPath(version.id, version.ext), {
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
      "content-disposition": attachmentDisposition(version.filename)
    })
    if (!sent) json(res, 404, { error: "file version is missing from the file store" })
    return true
  }

  json(res, 405, { error: "method not allowed" })
  return true
}

/** Parses a run request's optional { files: { slotId: versionId } }; throws RunRequestError on a bad shape. */
export function parseRunPins(body: Record<string, unknown>): Record<string, string> | null {
  if (body.files === undefined || body.files === null) return null
  if (typeof body.files !== "object" || Array.isArray(body.files)) {
    throw new RunRequestError("files must be an object of { slotId: versionId }")
  }
  const pins: Record<string, string> = {}
  for (const [slotId, versionId] of Object.entries(body.files as Record<string, unknown>)) {
    if (!ID_PATTERN.test(slotId) || typeof versionId !== "string") {
      throw new RunRequestError(`Invalid file pin for slot ${slotId}`)
    }
    pins[slotId] = versionId
  }
  return Object.keys(pins).length > 0 ? pins : null
}

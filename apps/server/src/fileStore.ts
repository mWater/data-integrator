/**
 * The file store: bytes of uploaded integration file versions, one file per
 * version at <root>/<versionId><ext>. Paths are built only from the version
 * id and a validated extension, never from the uploaded filename. Uploads
 * stream into .tmp while hashing and are renamed into place inside the
 * transaction that inserts their row; jobs that read files get their /in
 * directory under .jobs, on the same filesystem, so versions are hardlinked
 * rather than copied. The host never parses file contents.
 */

import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { copyFile, link, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import pg from "pg"

/** Store entries named like versions: a uuid plus an optional validated extension. */
const VERSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]{1,10})?$/

/** Age past which boot cleanup treats a leftover as abandoned, not in flight. */
export const LEFTOVER_AGE_MS = 60 * 60 * 1000

/** An upload went past the size cap; the partial file is gone. */
export class UploadTooLargeError extends Error {}

/** The disk filled during an upload; the partial file is gone. */
export class DiskFullError extends Error {}

/** A staged upload: hashed, flushed, waiting for its row. */
export interface StagedUpload {
  /** Absolute path under .tmp */
  tmpPath: string
  /** SHA-256 of the contents, hex */
  sha256: string
  /** Bytes received */
  sizeBytes: number
}

/** Local directory holding file versions; see the module comment for layout. */
export class FileStore {
  /** Absolute root directory of the store */
  readonly root: string

  /** Creates a store over a root directory. */
  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /** Absolute path of one version's bytes. */
  versionPath(versionId: string, ext: string): string {
    if (!VERSION_FILE.test(`${versionId}${ext}`)) throw new Error(`Invalid file version path: ${versionId}${ext}`)
    return path.join(this.root, `${versionId}${ext}`)
  }

  /** Staging directory for uploads in flight. */
  get tmpDir(): string {
    return path.join(this.root, ".tmp")
  }

  /** Parent of per-job /in directories. */
  get jobsDir(): string {
    return path.join(this.root, ".jobs")
  }

  /**
   * Streams a request body into .tmp while hashing it. Past maxBytes the
   * upload is cut off with UploadTooLargeError; a full disk is DiskFullError;
   * any other failure (a client abort included) rethrows. Every failure
   * removes the partial file. Resolves only once the bytes are flushed.
   */
  async stage(body: Readable, maxBytes: number): Promise<StagedUpload> {
    await mkdir(this.tmpDir, { recursive: true })
    const tmpPath = path.join(this.tmpDir, randomUUID())
    const hash = createHash("sha256")
    let sizeBytes = 0
    const out = createWriteStream(tmpPath, { flags: "wx", flush: true })
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const fail = (err: Error) => {
          if (settled) return
          settled = true
          body.unpipe(out)
          out.destroy()
          reject(err)
        }
        body.on("data", (chunk: Buffer) => {
          sizeBytes += chunk.length
          if (sizeBytes > maxBytes) {
            fail(new UploadTooLargeError(`File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`))
            return
          }
          hash.update(chunk)
        })
        body.on("error", fail)
        body.on("aborted", () => fail(new Error("Upload aborted by the client")))
        // A connection that closes before the body ended is an abort too
        body.on("close", () => {
          if (!body.readableEnded) fail(new Error("Upload aborted by the client"))
        })
        out.on("error", (err: NodeJS.ErrnoException) => {
          fail(err.code === "ENOSPC" ? new DiskFullError("The file store's disk is full") : err)
        })
        // A client that went away before this point fired its events already
        if (body.destroyed && !body.readableEnded) {
          fail(new Error("Upload aborted by the client"))
          return
        }
        // close, not finish: flush: true fsyncs just before the descriptor closes
        out.on("close", () => {
          if (settled) return
          settled = true
          resolve()
        })
        body.pipe(out)
      })
    } catch (err) {
      // The file opens asynchronously, so a destroyed stream may create it
      // after the failure; remove it once the stream has closed
      if (!out.closed) await new Promise<void>(resolve => out.once("close", () => resolve()))
      await rm(tmpPath, { force: true })
      throw err
    }
    return { tmpPath, sha256: hash.digest("hex"), sizeBytes }
  }

  /** New per-job directory under .jobs; the caller removes it. */
  async jobDir(): Promise<string> {
    await mkdir(this.jobsDir, { recursive: true })
    return mkdtemp(path.join(this.jobsDir, "job-"))
  }

  /** Hardlinks one version into place, copying when the target is on another filesystem. */
  async linkVersion(versionId: string, ext: string, target: string): Promise<void> {
    const source = this.versionPath(versionId, ext)
    try {
      await link(source, target)
    } catch {
      await copyFile(source, target)
    }
  }

  /** Removes one version's bytes; missing is fine. */
  async deleteVersion(versionId: string, ext: string): Promise<void> {
    await rm(this.versionPath(versionId, ext), { force: true })
  }
}

/**
 * Lowercase extension of an uploaded filename ("" when it has none). The
 * extension becomes part of the stored path, so anything outside the
 * validated shape is refused rather than sanitized.
 */
export function fileExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === "" || ext === ".") return ""
  if (!/^\.[a-z0-9]{1,10}$/.test(ext)) {
    throw new Error(`Unsupported file extension "${ext}": letters and digits only, up to 10`)
  }
  return ext
}

/**
 * Removes leftovers older than LEFTOVER_AGE_MS: staged uploads, job
 * directories, and version-named files with no live row (a commit that
 * failed after the rename, or a purge that crashed before deleting). Younger
 * entries may belong to another process sharing the store, and names that
 * do not look like versions are never touched. Returns how many were removed.
 */
export async function cleanupFileStore(
  pool: pg.Pool,
  store: FileStore,
  olderThanMs = LEFTOVER_AGE_MS
): Promise<number> {
  const cutoff = Date.now() - olderThanMs
  const old = async (entry: string) => {
    const stats = await stat(entry).catch(() => null)
    return stats !== null && stats.mtimeMs < cutoff
  }
  let removed = 0
  for (const dir of [store.tmpDir, store.jobsDir]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const entry = path.join(dir, name)
      if (await old(entry)) {
        await rm(entry, { recursive: true, force: true })
        removed++
      }
    }
  }
  const candidates: { name: string; id: string }[] = []
  for (const name of await readdir(store.root).catch(() => [] as string[])) {
    const match = name.match(VERSION_FILE)
    if (match && (await old(path.join(store.root, name)))) candidates.push({ name, id: match[1] })
  }
  if (candidates.length > 0) {
    const live = await pool.query(
      "SELECT id FROM app.file_versions WHERE id = ANY($1::uuid[]) AND purged_at IS NULL",
      [candidates.map(c => c.id)]
    )
    const liveIds = new Set(live.rows.map(r => r.id as string))
    for (const candidate of candidates) {
      if (liveIds.has(candidate.id)) continue
      await rm(path.join(store.root, candidate.name), { force: true })
      removed++
    }
  }
  return removed
}

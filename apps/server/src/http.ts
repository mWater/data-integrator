/**
 * Response and request-body helpers shared by the API's route modules.
 */

import { IncomingMessage, ServerResponse } from "node:http"
import { open } from "node:fs/promises"
import { pipeline } from "node:stream/promises"

/** Sends a JSON response. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/**
 * Streams a file as a 200 response with the given headers. The file is opened
 * before any header goes out, so a missing file can still be answered with an
 * error; a read failure mid-stream cuts the connection, because an unhandled
 * stream error would otherwise take the whole server process down. Returns
 * false, having sent nothing, when the file cannot be opened as a file.
 */
export async function sendFile(res: ServerResponse, file: string, headers: Record<string, string>): Promise<boolean> {
  let handle
  try {
    handle = await open(file, "r")
  } catch {
    return false
  }
  let size: number
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error("not a file")
    size = stats.size
  } catch {
    await handle.close()
    return false
  }
  res.writeHead(200, { ...headers, "content-length": String(size) })
  await pipeline(handle.createReadStream(), res).catch(() => res.destroy())
  return true
}

/** A request the client got wrong; the server answers with its status instead of 500. */
export class ClientError extends Error {
  /** HTTP status to answer with */
  readonly status: number

  /** Creates an error answered with the given status. */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Reads and parses a JSON request body (capped at 1 MB); malformed or oversized bodies are client errors. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1024 * 1024) throw new ClientError(413, "Request body too large (1 MB at most)")
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ClientError(400, "Request body is not valid JSON")
  }
}

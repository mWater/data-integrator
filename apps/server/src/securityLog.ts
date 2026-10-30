/**
 * Security event log: one JSON object per line on stdout, marked
 * `"type": "security"`, for the deployer's log management (journald, a log
 * forwarder, a SIEM). It covers sign-in outcomes, every write to the API (who,
 * what, target path, outcome, refusals included), accounts the account policy
 * disables, and integration run outcomes.
 *
 * Request bodies are never logged, so passwords, credential values and
 * payloads stay out; query strings are dropped and webhook paths have their
 * token redacted. Retention, integrity protection and alerting belong to the
 * deployer's log pipeline.
 */

import { IncomingMessage, ServerResponse } from "node:http"
import type { AuthUser } from "./auth.js"

/** Methods that change state; each is logged when its response finishes. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Writes one security event line. */
export function logSecurityEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), type: "security", event, ...fields })}\n`)
}

/** Actor fields for an event; userId null when unauthenticated. */
export function actorFields(user: AuthUser | null): Record<string, unknown> {
  return user ? { userId: user.id, email: user.email, role: user.role } : { userId: null }
}

/**
 * Where a request came from: the socket peer, plus X-Forwarded-For as sent,
 * which is trustworthy only when the deployer's proxy sets it.
 */
export function originFields(req: IncomingMessage): Record<string, unknown> {
  const forwarded = req.headers["x-forwarded-for"]
  return {
    ip: req.socket.remoteAddress ?? null,
    ...(forwarded ? { forwardedFor: Array.isArray(forwarded) ? forwarded.join(", ") : forwarded } : {})
  }
}

/** A request path safe to log: no query string, webhook token redacted. */
export function loggablePath(url: string): string {
  const pathname = url.split("?")[0]
  return pathname.startsWith("/hooks/") ? "/hooks/[redacted]" : pathname
}

/**
 * Logs a write request as event `api.write` when its response finishes, with
 * method, path, status and the user the request authenticated as (resolved
 * late, since routing resolves it). Sign-in logs its own `auth.login` events.
 */
export function auditWrite(req: IncomingMessage, res: ServerResponse, userOf: () => AuthUser | null): void {
  if (!WRITE_METHODS.has(req.method ?? "")) return
  const path = loggablePath(req.url ?? "/")
  if (path === "/api/login") return
  res.once("finish", () => {
    logSecurityEvent("api.write", { method: req.method, path, status: res.statusCode, ...actorFields(userOf()), ...originFields(req) })
  })
}

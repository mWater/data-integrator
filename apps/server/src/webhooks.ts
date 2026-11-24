/**
 * Webhook receiver: each integration carries a random webhook_token, and
 * possession of the token is the authentication. A sender presents it in one
 * of two ways, whichever it is able to do: as the capability URL
 * POST /hooks/<token>, or in a header on POST /hooks/<integration id>, which
 * keeps the token out of URLs and proxy logs. Senders are third-party systems
 * the platform cannot change, so the URL form stays for those that can only
 * post to a fixed address. Events buffer in app.webhook_events and
 * the next run consumes every pending one (executor batches them into
 * ctx.webhookData); a receipt enqueues that run immediately when the
 * integration is enabled and ready, and only buffers otherwise, so pausing
 * stops execution without dropping data.
 */

import { timingSafeEqual } from "node:crypto"
import { IncomingMessage } from "node:http"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { missingFileSlot } from "./files.js"

/** UUID shape of webhook tokens; also the path-segment guard for /hooks/:token. */
export const WEBHOOK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Integration id as the path segment of /hooks/:integrationId. Ids have no
 * hyphens and tokens always do, so the two forms of the URL cannot collide.
 */
export const WEBHOOK_INTEGRATION_ID_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * The webhook token a request carries in a header: `Authorization: Bearer
 * <token>`, or `X-Webhook-Token: <token>` for senders whose Authorization
 * header is not theirs to set. Null when neither holds a well-formed token.
 */
export function webhookHeaderToken(req: IncomingMessage): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec((req.headers.authorization ?? "").trim())
  const custom = req.headers["x-webhook-token"]
  for (const candidate of [bearer?.[1], Array.isArray(custom) ? custom[0] : custom]) {
    const token = candidate?.trim().toLowerCase()
    if (token && WEBHOOK_TOKEN_PATTERN.test(token)) return token
  }
  return null
}

/** Outcome of one accepted webhook receipt. */
export interface WebhookReceipt {
  /** Stored event id */
  eventId: string
  /** Run this receipt enqueued; null when one was already queued, the integration is paused/draft, or a file slot is still empty */
  runId: string | null
}

/** Columns of a webhook-accepting integration that a receipt needs. */
const RECEIVER_COLUMNS = `id, enabled, status, webhook_token::text AS token, definition->'files' AS files,
            COALESCE((definition->'trigger'->>'webhookDelaySeconds')::int, 0) AS delay`

/**
 * Stores one webhook event and enqueues a run for it. Returns null when no
 * webhook-accepting integration matches the token (unknown and non-webhook
 * integrations are indistinguishable to the sender). The event is inserted
 * before the enqueue attempt, so a run that was already queued picks it up
 * when it starts.
 */
export async function receiveWebhook(pool: pg.Pool, token: string, payload: unknown): Promise<WebhookReceipt | null> {
  const integration = await pool.query(
    `SELECT ${RECEIVER_COLUMNS}
     FROM app.integrations
     WHERE webhook_token = $1 AND definition->'trigger'->>'webhook' = 'true'`,
    [token]
  )
  if (integration.rows.length === 0) return null
  return storeEvent(pool, integration.rows[0], payload)
}

/**
 * receiveWebhook for a request that names its integration in the URL and
 * carries the token in a header. Returns null when the id is unknown, the
 * integration does not accept webhooks, or the token is not its token; the
 * sender cannot tell these apart.
 */
export async function receiveWebhookFor(
  pool: pg.Pool,
  integrationId: string,
  token: string,
  payload: unknown
): Promise<WebhookReceipt | null> {
  const integration = await pool.query(
    `SELECT ${RECEIVER_COLUMNS}
     FROM app.integrations
     WHERE id = $1 AND definition->'trigger'->>'webhook' = 'true'`,
    [integrationId]
  )
  const row = integration.rows[0]
  const presented = Buffer.from(token)
  const expected = Buffer.from(String(row?.token ?? ""))
  if (!row || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  return storeEvent(pool, row, payload)
}

/** The integration a receipt resolved to, as RECEIVER_COLUMNS selects it. */
interface ReceiverRow {
  /** Integration id */
  id: string
  /** False while paused */
  enabled: boolean
  /** draft or ready */
  status: string
  /** Batch window in seconds */
  delay: number
  /** The definition's file slots, if any */
  files: IntegrationDefinition["files"] | null
}

/** Inserts the event for an authenticated receipt and enqueues its run. */
async function storeEvent(pool: pg.Pool, integration: ReceiverRow, payload: unknown): Promise<WebhookReceipt> {
  const { id, enabled, status, delay, files } = integration

  const event = await pool.query(
    "INSERT INTO app.webhook_events (integration_id, payload) VALUES ($1, $2) RETURNING id",
    [id, JSON.stringify(payload ?? null)]
  )

  // The one-queued unique index coalesces bursts: the first event opens the
  // batch window (scheduled_at = now + webhookDelaySeconds) and later events
  // conflict into the same run, so constant traffic cannot starve it
  let runId: string | null = null
  // An empty file slot would only fail the run; the event waits for the upload's run
  const awaitingFile = files ? await missingFileSlot(pool, id, { files } as IntegrationDefinition) : null
  if (enabled && status === "ready" && !awaitingFile) {
    const run = await pool.query(
      `INSERT INTO app.runs (integration_id, trigger, status, scheduled_at)
       VALUES ($1, 'webhook', 'queued', now() + make_interval(secs => $2))
       ON CONFLICT DO NOTHING RETURNING id`,
      [id, delay]
    )
    runId = run.rows[0]?.id ?? null
  }
  return { eventId: event.rows[0].id, runId }
}

/** Reads an integration's webhook token, or null for unknown ids. */
export async function getWebhookToken(pool: pg.Pool, integrationId: string): Promise<string | null> {
  const result = await pool.query("SELECT webhook_token FROM app.integrations WHERE id = $1", [integrationId])
  return result.rows[0]?.webhook_token ?? null
}

/** Rotates an integration's webhook token, invalidating the old URL immediately; null for unknown ids. */
export async function rotateWebhookToken(pool: pg.Pool, integrationId: string): Promise<string | null> {
  const result = await pool.query(
    "UPDATE app.integrations SET webhook_token = gen_random_uuid() WHERE id = $1 RETURNING webhook_token",
    [integrationId]
  )
  return result.rows[0]?.webhook_token ?? null
}

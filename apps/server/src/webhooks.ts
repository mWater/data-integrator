/**
 * Webhook receiver: each integration carries a random webhook_token, and
 * POST /hooks/<token> is the capability URL senders use, so possession of
 * the token is the authentication. Events buffer in app.webhook_events and
 * the next run consumes every pending one (executor batches them into
 * ctx.webhookData); a receipt enqueues that run immediately when the
 * integration is enabled and ready, and only buffers otherwise, so pausing
 * stops execution without dropping data.
 */

import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { missingFileSlot } from "./files.js"

/** UUID shape of webhook tokens; also the path-segment guard for /hooks/:token. */
export const WEBHOOK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Outcome of one accepted webhook receipt. */
export interface WebhookReceipt {
  /** Stored event id */
  eventId: string
  /** Run this receipt enqueued; null when one was already queued, the integration is paused/draft, or a file slot is still empty */
  runId: string | null
}

/**
 * Stores one webhook event and enqueues a run for it. Returns null when no
 * webhook-accepting integration matches the token (unknown and non-webhook
 * integrations are indistinguishable to the sender). The event is inserted
 * before the enqueue attempt, so a run that was already queued picks it up
 * when it starts.
 */
export async function receiveWebhook(pool: pg.Pool, token: string, payload: unknown): Promise<WebhookReceipt | null> {
  const integration = await pool.query(
    `SELECT id, enabled, status, definition->'files' AS files,
            COALESCE((definition->'trigger'->>'webhookDelaySeconds')::int, 0) AS delay
     FROM app.integrations
     WHERE webhook_token = $1 AND definition->'trigger'->>'webhook' = 'true'`,
    [token]
  )
  if (integration.rows.length === 0) return null
  const { id, enabled, status, delay, files } = integration.rows[0]

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

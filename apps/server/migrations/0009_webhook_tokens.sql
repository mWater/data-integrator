-- Capability-URL secret for the public webhook receiver: senders POST to
-- /hooks/<token>, so possession of the token is the authentication.
ALTER TABLE app.integrations
  ADD COLUMN webhook_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX integrations_webhook_token_idx ON app.integrations (webhook_token);

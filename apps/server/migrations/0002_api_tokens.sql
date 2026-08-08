-- Personal access tokens: bearer credentials for the programmatic API.
-- The token itself is shown once at mint; only its SHA-256 is stored.
CREATE TABLE app.api_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX api_tokens_user_idx ON app.api_tokens (user_id, created_at DESC);

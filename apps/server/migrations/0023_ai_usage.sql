-- Daily AI token usage per user (null: CLI sessions), counted against the
-- deployment's daily caps (aiLimits.ts). Days are UTC.
CREATE TABLE app.ai_usage (
  day date NOT NULL,
  user_id uuid REFERENCES app.users(id) ON DELETE CASCADE,
  tokens bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ai_usage_day_user ON app.ai_usage (day, user_id) NULLS NOT DISTINCT;

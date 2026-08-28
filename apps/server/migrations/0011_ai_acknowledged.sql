-- One-time per-user acknowledgement that AI features send data to an external
-- model provider; null until the user accepts the notice.
ALTER TABLE app.users
  ADD COLUMN ai_acknowledged_at timestamptz;

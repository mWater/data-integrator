-- Clocks for the optional account policy (accountPolicy.ts): password age and
-- account inactivity. Existing accounts start both at migration time.
ALTER TABLE app.users
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now();

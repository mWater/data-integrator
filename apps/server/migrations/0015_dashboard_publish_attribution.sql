-- Making a dashboard public opens its data to anyone on the internet, so the
-- act is recorded: who flipped it public and when. Cleared when made private.
ALTER TABLE app.dashboards
  ADD COLUMN published_by uuid REFERENCES app.users(id),
  ADD COLUMN published_at timestamptz;

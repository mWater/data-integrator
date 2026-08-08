-- Integration lifecycle: draft (installed by a design session, not yet
-- certified) vs ready (passed a cold run, or installed from the library).
ALTER TABLE app.integrations
  ADD COLUMN status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft', 'ready'));

-- Everything installed before this migration predates design-session installs
UPDATE app.integrations SET status = 'ready';

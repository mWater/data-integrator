-- Design sessions run in a scratch area: runs and preview layers owned by the
-- session instead of an installed integration. Nothing is installed until the
-- session's finish saves the certified definition.

ALTER TABLE app.runs ALTER COLUMN integration_id DROP NOT NULL;
ALTER TABLE app.runs ADD COLUMN session_id uuid REFERENCES app.agent_sessions(id);
ALTER TABLE app.runs ADD CONSTRAINT runs_owner_check
  CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL);
CREATE UNIQUE INDEX runs_one_running_session_idx ON app.runs (session_id)
  WHERE status = 'running' AND session_id IS NOT NULL;
CREATE UNIQUE INDEX runs_one_queued_session_idx ON app.runs (session_id)
  WHERE status = 'queued' AND session_id IS NOT NULL;

ALTER TABLE app.raster_layers ALTER COLUMN integration_id DROP NOT NULL;
ALTER TABLE app.raster_layers ADD COLUMN session_id uuid REFERENCES app.agent_sessions(id);
ALTER TABLE app.raster_layers ADD CONSTRAINT raster_layers_owner_check
  CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL);

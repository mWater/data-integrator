-- Last loop error of an agent session (model/provider failures), cleared on
-- the next successful step. Crashed sessions persist as paused with this set.
ALTER TABLE app.agent_sessions ADD COLUMN error text;

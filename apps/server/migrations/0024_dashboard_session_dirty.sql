-- Dashboard sessions carry an explicit dirty flag: a built draft that was
-- never saved is unsaved, anything else is clean.
UPDATE app.agent_sessions
SET client_state = jsonb_set(
  client_state, '{dirty}',
  to_jsonb(client_state->'saved' = 'null'::jsonb AND client_state->'build' IS NOT NULL AND client_state->'build' <> 'null'::jsonb)
)
WHERE kind = 'dashboard' AND NOT (client_state ? 'dirty');

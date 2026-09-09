-- Runtime ids name a language only; the language version is a property of the
-- runtime image release, not of the definition. Rewrite every stored
-- definition, including version history and in-progress design sessions.
UPDATE app.integrations
  SET definition = jsonb_set(definition, '{runtime}', '"python"')
  WHERE definition->>'runtime' = 'python3.12';
UPDATE app.integrations
  SET definition = jsonb_set(definition, '{runtime}', '"node"')
  WHERE definition->>'runtime' = 'node22';

UPDATE app.integration_versions
  SET definition = jsonb_set(definition, '{runtime}', '"python"')
  WHERE definition->>'runtime' = 'python3.12';
UPDATE app.integration_versions
  SET definition = jsonb_set(definition, '{runtime}', '"node"')
  WHERE definition->>'runtime' = 'node22';

UPDATE app.agent_sessions
  SET client_state = jsonb_set(client_state, '{definition,runtime}', '"python"')
  WHERE client_state->'definition'->>'runtime' = 'python3.12';
UPDATE app.agent_sessions
  SET client_state = jsonb_set(client_state, '{definition,runtime}', '"node"')
  WHERE client_state->'definition'->>'runtime' = 'node22';

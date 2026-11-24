-- Every stored definition carries `trigger`, as the definition format requires.
-- A definition saved without one has always been run by hand only, which is
-- what an empty trigger means, so adding it changes no behavior.
UPDATE app.integrations
  SET definition = jsonb_set(definition, '{trigger}', '{}'::jsonb)
  WHERE NOT definition ? 'trigger';
UPDATE app.integration_versions
  SET definition = jsonb_set(definition, '{trigger}', '{}'::jsonb)
  WHERE NOT definition ? 'trigger';

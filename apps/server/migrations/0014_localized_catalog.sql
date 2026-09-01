-- Localized data catalog: raster layer display names become LocalizedString
-- jsonb (matching the definitions), and agent sessions record the locale the
-- client was using, which seeds the base language of authored text and the
-- language of model-facing schema descriptions.
ALTER TABLE app.raster_layers
  ALTER COLUMN name TYPE jsonb USING jsonb_build_object('_base', 'en', 'en', name);

ALTER TABLE app.agent_sessions
  ADD COLUMN locale text;

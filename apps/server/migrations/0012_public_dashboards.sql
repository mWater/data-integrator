-- Public dashboards: an editor-set flag opens a dashboard's view surface
-- (bundle, stored queries, declared raster layers) to unauthenticated viewers.
ALTER TABLE app.dashboards
  ADD COLUMN public boolean NOT NULL DEFAULT false;

-- Raster catalog layers a dashboard version may draw, declared at save time
-- like its queries; the scoped tile route serves only declared layers.
ALTER TABLE app.dashboard_versions
  ADD COLUMN layers jsonb NOT NULL DEFAULT '[]';

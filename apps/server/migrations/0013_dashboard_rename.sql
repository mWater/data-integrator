-- Renamable dashboard slugs: the id stays the natural key, but a single
-- UPDATE of app.dashboards.id now cascades through every reference, so a
-- badly chosen slug (the designer agent picks the initial one) is not
-- permanent. The circular current_version check defers to commit because the
-- cascaded version rows and the parent row change in the same statement.
ALTER TABLE app.dashboard_versions
  DROP CONSTRAINT dashboard_versions_dashboard_id_fkey,
  ADD CONSTRAINT dashboard_versions_dashboard_id_fkey
    FOREIGN KEY (dashboard_id) REFERENCES app.dashboards(id) ON UPDATE CASCADE;

ALTER TABLE app.agent_sessions
  DROP CONSTRAINT agent_sessions_dashboard_id_fkey,
  ADD CONSTRAINT agent_sessions_dashboard_id_fkey
    FOREIGN KEY (dashboard_id) REFERENCES app.dashboards(id) ON UPDATE CASCADE;

ALTER TABLE app.dashboards
  ALTER CONSTRAINT dashboards_current_version_fk DEFERRABLE INITIALLY DEFERRED;

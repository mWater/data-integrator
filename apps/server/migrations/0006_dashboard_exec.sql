-- Dashboards per Dashboards.md: the compiled bundle is a JS + CSS pair, and stored
-- dashboard SQL executes under a dedicated read-only role.

ALTER TABLE app.dashboard_versions DROP COLUMN bundle;
ALTER TABLE app.dashboard_versions ADD COLUMN bundle_js text NOT NULL;
ALTER TABLE app.dashboard_versions ADD COLUMN bundle_css text NOT NULL;

-- sql_engine: SELECT on data only, no grants on app (the app/data split is the
-- security boundary). The app role gets membership so executors can SET LOCAL ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sql_engine') THEN
    CREATE ROLE sql_engine NOLOGIN;
  END IF;
  EXECUTE format('GRANT sql_engine TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA data TO sql_engine;
GRANT SELECT ON ALL TABLES IN SCHEMA data TO sql_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA data GRANT SELECT ON TABLES TO sql_engine;

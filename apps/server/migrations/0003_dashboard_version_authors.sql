-- Who saved each dashboard version, and the version a restore copied.
-- Versions saved before this migration have no recorded author.
ALTER TABLE app.dashboard_versions
  ADD COLUMN created_by uuid REFERENCES app.users(id),
  ADD COLUMN restored_from int;

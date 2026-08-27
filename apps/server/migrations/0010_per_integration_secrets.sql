-- Secrets become per-integration: values belong to one integration and are
-- injected only into its runs, so an imported definition cannot receive a
-- credential by declaring another integration's secret name. Values remain
-- individually encrypted (AES-256-GCM envelope per value) and write-only.

CREATE TABLE app.integration_secrets (
  integration_id text NOT NULL REFERENCES app.integrations(id) ON DELETE CASCADE,
  name text NOT NULL,
  value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, name)
);

-- Carry existing values to every installed integration that declares the
-- name; values no installed integration declares do not survive.
INSERT INTO app.integration_secrets (integration_id, name, value, created_at, updated_at)
SELECT i.id, s.name, s.value, s.created_at, s.updated_at
FROM app.secrets s
JOIN app.integrations i
  ON i.definition->'secrets' ? s.name;

DROP TABLE app.secrets;

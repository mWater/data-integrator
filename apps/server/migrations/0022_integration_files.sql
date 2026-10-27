-- Integration files (Integration Files.md): uploaded file versions per
-- declared slot, the version each slot currently uses, and the pins a run
-- was created with. Bytes live in the file store at <id><ext>; a row whose
-- bytes were purged keeps its sha256 so lineage still resolves.
CREATE TABLE app.file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owning integration; null while a design session's upload waits for its
  -- draft row, which adopts it
  integration_id text REFERENCES app.integrations(id),
  -- Design session the file was attached in; null for integration-page uploads
  session_id uuid REFERENCES app.agent_sessions(id),
  slot_id text NOT NULL,
  version int NOT NULL,
  filename text NOT NULL,
  ext text NOT NULL CHECK (ext = '' OR ext ~ '^\.[a-z0-9]{1,10}$'),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_by uuid REFERENCES app.users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  purged_by text,
  CONSTRAINT file_versions_owner_check CHECK (integration_id IS NOT NULL OR session_id IS NOT NULL)
);
-- Versions count up per slot of their owner: the integration once it owns
-- them, the session before that
CREATE UNIQUE INDEX file_versions_integration_idx ON app.file_versions (integration_id, slot_id, version)
  WHERE integration_id IS NOT NULL;
CREATE UNIQUE INDEX file_versions_session_idx ON app.file_versions (session_id, slot_id, version)
  WHERE integration_id IS NULL;

-- The version each slot of an integration uses when a run pins nothing; set
-- only by a successful production run's commit
CREATE TABLE app.file_slots (
  integration_id text NOT NULL REFERENCES app.integrations(id),
  slot_id text NOT NULL,
  current_version_id uuid NOT NULL REFERENCES app.file_versions(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, slot_id)
);

-- { slotId: versionId } fixed when the run was created; null pins nothing
ALTER TABLE app.runs ADD COLUMN file_pins jsonb;

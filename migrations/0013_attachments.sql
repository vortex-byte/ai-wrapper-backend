-- 0013 — attachments & file_extractions (Phase 4 — AGENTS §6.7, PRD §12, docs/PHASE_4_PLAN.md M4.1)
-- Attachments are the single record for binary artifacts, both user uploads (`origin=input`)
-- and provider-generated files hydrated by the ArtifactSink (`origin=generated`).
-- `message_parts.file_id` gets its FK here (deferred from 0009).

CREATE TABLE attachments (
  id               uuid PRIMARY KEY,
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  message_part_id  uuid,
  origin           text NOT NULL CHECK (origin IN ('input','generated')),
  kind             text NOT NULL CHECK (kind IN ('image','document','other')),
  display_name     text NOT NULL,
  declared_mime    text,
  detected_mime    text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  sha256           char(64) NOT NULL,
  storage_provider text NOT NULL,
  storage_bucket   text,
  storage_key      text NOT NULL,
  status           text NOT NULL CHECK (status IN
                     ('uploading','validating','processing','ready','rejected','failed','missing','expired','deleted')),
  error_code       text,
  width            int,
  height           int,
  page_count       int,
  metadata         jsonb NOT NULL DEFAULT '{}',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  pinned_at        timestamptz,
  UNIQUE (storage_key)
);

CREATE TABLE file_extractions (
  file_id        uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN ('pending','done','failed','unsupported')),
  extractor      text,
  text           text,
  char_count     int CHECK (char_count >= 0),
  token_estimate int,
  truncated      boolean NOT NULL DEFAULT false,
  page_count     int,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The deferred FK from 0009 (comment there: "FK to attachments added in Phase 4").
ALTER TABLE message_parts
  ADD CONSTRAINT message_parts_file_fk FOREIGN KEY (file_id) REFERENCES attachments(id);

CREATE INDEX attachments_owner_conv_idx ON attachments (owner_user_id, conversation_id);
CREATE INDEX attachments_message_idx    ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_expiry_idx     ON attachments (expires_at) WHERE status NOT IN ('expired','deleted');
CREATE INDEX attachments_sha256_idx     ON attachments (sha256);

-- Grants: attachments is mutable DML. Follows the 0012 pattern: grant `aichat_app` when the
-- least-privilege VPS role exists (dev runs as table owner and bypasses grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aichat_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON attachments, file_extractions TO aichat_app;
  END IF;
END $$;

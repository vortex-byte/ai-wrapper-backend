-- 0009 — conversations, messages, message_parts (AGENTS §6.6 / PRD §10, §17)
-- Ordered parts instead of a content column (D-5): new part types need no migration,
-- only a CHECK update. `message_parts.file_id` has no FK yet — attachments land in Phase 4.

CREATE TABLE conversations (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  model_id        uuid NOT NULL REFERENCES ai_models(id),
  title           text NOT NULL DEFAULT 'New conversation',
  message_count   int  NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
-- Keyset conversation list. Both sort keys are ASC/DESC-consistent with the
-- `(sort_ts, id) < (cursor_ts, cursor_id)` row comparison (UUIDv7 ids are time-ordered).
CREATE INDEX conversations_user_recent_idx
  ON conversations (user_id, COALESCE(last_message_at, created_at) DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX conversations_model_idx ON conversations (model_id);

-- Enforce "one model per conversation" once messages exist (FR-CONV-1).
CREATE FUNCTION forbid_model_switch() RETURNS trigger AS $$
BEGIN
  IF NEW.model_id <> OLD.model_id AND OLD.message_count > 0 THEN
    RAISE EXCEPTION 'conversation model is immutable after first message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_model_lock
  BEFORE UPDATE OF model_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION forbid_model_switch();

CREATE TABLE messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  role            text   NOT NULL CHECK (role IN ('user','assistant')),
  status          text   NOT NULL CHECK (status IN ('streaming','complete','incomplete','failed')),
  finish_reason   text CHECK (finish_reason IN
                    ('stop','length','content_filter','cancelled','error','timeout','interrupted')),
  superseded_by   uuid REFERENCES messages(id),
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_streaming_idx ON messages (status) WHERE status = 'streaming';

CREATE TABLE message_parts (
  id           uuid PRIMARY KEY,
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position     int  NOT NULL CHECK (position >= 0),
  type         text NOT NULL CHECK (type IN
                 ('text','image','document','generated_file','structured','tool_call','tool_result','reasoning')),
  status       text NOT NULL DEFAULT 'complete'
                 CHECK (status IN ('streaming','complete','incomplete','failed')),
  text_content text,
  data         jsonb NOT NULL DEFAULT '{}',
  file_id      uuid,                       -- FK to attachments added in Phase 4
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position),
  CHECK (type <> 'text' OR file_id IS NULL),
  CHECK (status <> 'complete' OR type NOT IN ('image','document','generated_file') OR file_id IS NOT NULL)
) WITH (fillfactor = 80);
CREATE INDEX message_parts_file_idx ON message_parts (file_id) WHERE file_id IS NOT NULL;

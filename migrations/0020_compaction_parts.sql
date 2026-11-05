-- 0020 — message_parts: provider-native compaction blocks
--
-- A model that supports provider-side compaction (Anthropic `compact_20260112`, OpenAI
-- Responses `context_management.compaction`) returns a block that replaces older turns. The
-- block is provider-owned and must be replayed verbatim on later requests, so it is stored as
-- a message part next to the assistant reply that produced it.

ALTER TABLE message_parts DROP CONSTRAINT IF EXISTS message_parts_type_check;

ALTER TABLE message_parts
  ADD CONSTRAINT message_parts_type_check
  CHECK (type IN
    ('text','image','document','generated_file','structured','tool_call','tool_result','reasoning','compaction'))
  NOT VALID;

ALTER TABLE message_parts VALIDATE CONSTRAINT message_parts_type_check;

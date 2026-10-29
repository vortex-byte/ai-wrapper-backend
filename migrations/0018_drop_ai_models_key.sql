-- 0018 — ai_models: drop the redundant human-entered `key` column
--
-- The model `key` was never read at runtime: generation resolves models by UUID and the upstream
-- identifier is `api_model_id`. Its only consumers were a duplicate check on create and the
-- `modelKey` field in usage-report groupings, which now falls back to `api_model_id`.
--
-- 0008 declared `key TEXT NOT NULL UNIQUE` (global), but src/db/schema.ts never declared that
-- constraint. Dropping the column removes the drift; `(provider_id, api_model_id)` remains the
-- real uniqueness guarantee.

ALTER TABLE ai_models DROP CONSTRAINT IF EXISTS ai_models_key_key;
DROP INDEX IF EXISTS ai_models_key_key_idx;
ALTER TABLE ai_models DROP COLUMN IF EXISTS key;

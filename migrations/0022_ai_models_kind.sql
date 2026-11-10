-- 0022 — ai_models: mark image-generation models with `config.kind`
--
-- Image models materialized by the settings page were flagged with `config.internal`, which both
-- hid them from the admin list and the user picker. The admin list now shows them with a "type"
-- badge instead, so the flag needs one unambiguous meaning: which kind of model this row is.
--
-- `kind` replaces `internal`. It is `'image'` for rows the settings page materialized and `'chat'`
-- for everything else; the user picker keeps hiding `'image'`.
--
-- Backfill-only: existing rows keep working, `internal` is dropped from config in the same pass.

UPDATE ai_models
   SET config = (config - 'internal') || jsonb_build_object('kind', 'image')
 WHERE config->>'internal' = 'true'
   AND config->>'kind' IS NULL;

UPDATE ai_models
   SET config = config || jsonb_build_object('kind', 'chat')
 WHERE config->>'kind' IS NULL;

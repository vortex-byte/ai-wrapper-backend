-- 0023 — ai_models: drop `config.local.license`
--
-- Local model metadata no longer records a license: it was display-only and the product does not
-- surface model terms. `config.local` is validated as a strict object, so a leftover key would make
-- every existing local model unreadable (its `local` block would parse as null in GET /api/models).

UPDATE ai_models
   SET config = jsonb_set(config, '{local}', (config->'local') - 'license')
 WHERE config->'local' ? 'license';

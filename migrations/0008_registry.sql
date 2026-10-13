-- 0008 — provider & model registry (AGENTS §6.5 / PRD §9.4, §17)
-- Runtime-editable rows: adding a provider/model is an admin action, never a deploy.
-- `secret_ref` is the NAME of the env var holding the key (A-16) — the key is never stored here.

CREATE TABLE ai_providers (
  id             uuid PRIMARY KEY,
  key            text NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  display_name   text NOT NULL CHECK (length(btrim(display_name)) > 0),
  adapter        text NOT NULL CHECK (length(btrim(adapter)) > 0),
  base_url       text,
  secret_ref     text NOT NULL CHECK (length(btrim(secret_ref)) > 0), -- env var NAME (A-16)
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  config         jsonb NOT NULL DEFAULT '{}',
  config_version int NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_providers_status_idx ON ai_providers (status);

CREATE TABLE ai_models (
  id                       uuid PRIMARY KEY,
  provider_id              uuid NOT NULL REFERENCES ai_providers(id),
  key                      text NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  api_model_id             text NOT NULL CHECK (length(btrim(api_model_id)) > 0),
  display_name             text NOT NULL CHECK (length(btrim(display_name)) > 0),
  description              text,
  status                   text NOT NULL DEFAULT 'disabled'
                             CHECK (status IN ('active','disabled')),
  capabilities             jsonb NOT NULL,
  context_window           int  NOT NULL CHECK (context_window > 0),
  max_output_tokens        int  NOT NULL CHECK (max_output_tokens > 0),
  default_max_output_tokens int NOT NULL CHECK (default_max_output_tokens > 0),
  quota_weight             numeric(8,3) NOT NULL DEFAULT 1.000 CHECK (quota_weight > 0),
  config                   jsonb NOT NULL DEFAULT '{}',
  sort_order               int NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (default_max_output_tokens <= max_output_tokens)
);
CREATE UNIQUE INDEX ai_models_provider_api_id_uq ON ai_models (provider_id, api_model_id);
CREATE INDEX ai_models_list_idx     ON ai_models (status, sort_order, id);
CREATE INDEX ai_models_provider_idx ON ai_models (provider_id);

CREATE TABLE ai_model_prices (
  id                           uuid PRIMARY KEY,
  model_id                     uuid NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  effective_from               timestamptz NOT NULL,
  input_micros_per_mtok        bigint NOT NULL CHECK (input_micros_per_mtok  >= 0),
  output_micros_per_mtok       bigint NOT NULL CHECK (output_micros_per_mtok >= 0),
  cached_input_micros_per_mtok bigint CHECK (cached_input_micros_per_mtok >= 0),
  currency                     char(3) NOT NULL DEFAULT 'USD',
  created_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, effective_from)
);

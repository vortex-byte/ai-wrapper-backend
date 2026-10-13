-- 0010 — quota, usage & idempotency tables (AGENTS §6.8/§6.9 / PRD §11, §17)
-- SCHEMA ONLY: the quota machinery (reserve/settle/release, ledger writes, rollups) is Phase 3.
-- FKs to `generation_jobs` are deferred to the Phase 2 migration that creates that table;
-- the columns exist now so Phase 2/3 add only constraints, never a rewrite.

CREATE TABLE quota_policies (
  id                            uuid PRIMARY KEY,
  scope                         text NOT NULL CHECK (scope IN ('global','division','user')),
  division_id                   uuid REFERENCES divisions(id),
  user_id                       uuid REFERENCES users(id),
  monthly_tokens                bigint CHECK (monthly_tokens >= 0),
  max_input_tokens_per_request  int CHECK (max_input_tokens_per_request > 0),
  max_output_tokens_per_request int CHECK (max_output_tokens_per_request > 0),
  max_concurrent_generations    int CHECK (max_concurrent_generations > 0),
  allowed_model_ids             uuid[],
  updated_by                    uuid REFERENCES users(id),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope='global'   AND division_id IS NULL     AND user_id IS NULL)
      OR (scope='division' AND division_id IS NOT NULL AND user_id IS NULL)
      OR (scope='user'     AND user_id IS NOT NULL     AND division_id IS NULL))
);
CREATE UNIQUE INDEX quota_policy_scope_uq
  ON quota_policies (scope, COALESCE(division_id, user_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE quota_accounts (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  scope_type        text NOT NULL DEFAULT 'total' CHECK (scope_type IN ('total','provider','model')),
  scope_id          uuid,
  period_start      timestamptz NOT NULL,
  period_end        timestamptz NOT NULL,
  base_limit_tokens bigint NOT NULL CHECK (base_limit_tokens >= 0),
  adjustment_tokens bigint NOT NULL DEFAULT 0,
  used_tokens       bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens   bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  limits            jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
) WITH (fillfactor = 80);
CREATE UNIQUE INDEX quota_accounts_uq
  ON quota_accounts (user_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'), period_start);
CREATE INDEX quota_accounts_user_period_idx ON quota_accounts (user_id, period_start DESC);

CREATE TABLE quota_reservations (
  id              uuid PRIMARY KEY,
  generation_id   uuid NOT NULL UNIQUE,      -- FK -> generation_jobs(id) added in Phase 2
  user_id         uuid NOT NULL REFERENCES users(id),
  account_id      uuid NOT NULL REFERENCES quota_accounts(id),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  settled_tokens  bigint CHECK (settled_tokens >= 0),
  status          text NOT NULL CHECK (status IN ('active','settled','released','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finalized_at    timestamptz
);
CREATE INDEX quota_res_active_exp_idx ON quota_reservations (expires_at) WHERE status = 'active';

CREATE TABLE quota_ledger (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL,
  account_id     uuid NOT NULL REFERENCES quota_accounts(id),
  generation_id  uuid,                       -- FK -> generation_jobs(id) ON DELETE SET NULL added in Phase 2
  entry_type     text NOT NULL CHECK (entry_type IN
                   ('period_open','reserve','settle','release','expire_release','adjust','grant')),
  tokens_delta   bigint NOT NULL DEFAULT 0,
  used_after     bigint NOT NULL,
  reserved_after bigint NOT NULL,
  actor_user_id  uuid REFERENCES users(id),
  reason         text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_ledger_user_time_idx ON quota_ledger (user_id, created_at DESC);
CREATE INDEX quota_ledger_account_idx   ON quota_ledger (account_id, id);

CREATE TABLE usage_events (
  id                     uuid PRIMARY KEY,
  generation_id          uuid NOT NULL UNIQUE, -- FK -> generation_jobs(id) added in Phase 2
  user_id                uuid NOT NULL REFERENCES users(id),
  division_id            uuid REFERENCES divisions(id),
  provider_id            uuid NOT NULL REFERENCES ai_providers(id),
  model_id               uuid NOT NULL REFERENCES ai_models(id),
  account_id             uuid NOT NULL REFERENCES quota_accounts(id),
  input_tokens           int  NOT NULL CHECK (input_tokens  >= 0),
  output_tokens          int  NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens    int  CHECK (cached_input_tokens >= 0),
  reasoning_tokens       int  CHECK (reasoning_tokens >= 0),
  quota_tokens           bigint NOT NULL CHECK (quota_tokens >= 0),
  overshoot_tokens       bigint NOT NULL DEFAULT 0 CHECK (overshoot_tokens >= 0),
  usage_source           text NOT NULL CHECK (usage_source IN ('provider','estimated')),
  est_cost_micros        bigint CHECK (est_cost_micros >= 0),
  cost_currency          char(3) NOT NULL DEFAULT 'USD',
  outcome                text NOT NULL CHECK (outcome IN ('completed','cancelled','failed')),
  error_category         text,
  duration_ms            int CHECK (duration_ms >= 0),
  time_to_first_token_ms int CHECK (time_to_first_token_ms >= 0),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_time_idx     ON usage_events (user_id, created_at DESC);
CREATE INDEX usage_events_model_time_idx    ON usage_events (model_id, created_at DESC);
CREATE INDEX usage_events_division_time_idx ON usage_events (division_id, created_at DESC);

CREATE TABLE usage_daily (
  day             date NOT NULL,
  user_id         uuid NOT NULL,
  division_id     uuid,
  provider_id     uuid NOT NULL,
  model_id        uuid NOT NULL,
  requests        int    NOT NULL CHECK (requests >= 0),
  failed_requests int    NOT NULL CHECK (failed_requests >= 0),
  input_tokens    bigint NOT NULL CHECK (input_tokens  >= 0),
  output_tokens   bigint NOT NULL CHECK (output_tokens >= 0),
  quota_tokens    bigint NOT NULL CHECK (quota_tokens  >= 0),
  est_cost_micros bigint CHECK (est_cost_micros >= 0),
  PRIMARY KEY (day, user_id, model_id)
);
CREATE INDEX usage_daily_day_idx       ON usage_daily (day);
CREATE INDEX usage_daily_model_day_idx ON usage_daily (model_id, day);

CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    char(64) NOT NULL,
  response_status int NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Append-only enforcement (AGENTS §6.11). No-op on the single-owner dev role, where the
-- executing role owns the tables and would bypass grants anyway; real on the VPS deploy,
-- where the service runs as a non-owner `aichat_app` role created by the deploy guide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aichat_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ai_providers, ai_models, ai_model_prices,
      conversations, messages, message_parts,
      quota_policies, quota_accounts, quota_reservations, usage_events, usage_daily,
      idempotency_keys
    TO aichat_app;
    GRANT SELECT, INSERT ON quota_ledger, audit_logs TO aichat_app;
    REVOKE UPDATE, DELETE ON quota_ledger, audit_logs FROM aichat_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aichat_app;
  END IF;
END $$;

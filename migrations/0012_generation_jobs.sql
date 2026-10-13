-- 0012 — generation_jobs: the generation record = the job record (PRD §14.6, AGENTS §6.8)
-- Phase 2 (generation core). Also lands the deferred FKs from 0010 and back-fills the
-- `aichat_app` grants that the 0010 block missed (users/sessions/divisions/system_settings/
-- jobs/error_events) — without those, a least-privilege VPS deploy cannot even sign in.

CREATE TABLE generation_jobs (
  id                  uuid PRIMARY KEY,
  request_id          text NOT NULL UNIQUE,
  user_id             uuid NOT NULL REFERENCES users(id),
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  model_id            uuid NOT NULL REFERENCES ai_models(id),
  provider_id         uuid NOT NULL REFERENCES ai_providers(id),
  status              text NOT NULL CHECK (status IN ('pending','generating','completed','cancelled','failed')),
  runner_id           text,
  cancel_reason       text CHECK (cancel_reason IN ('user_cancel','detached','shutdown')),
  started_at          timestamptz,
  heartbeat_at        timestamptz,
  finished_at         timestamptz,
  last_event_seq      bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  est_input_tokens    int CHECK (est_input_tokens >= 0),
  max_output_tokens   int NOT NULL CHECK (max_output_tokens > 0),
  model_lock          jsonb NOT NULL DEFAULT '{}',
  options             jsonb NOT NULL DEFAULT '{}',
  context_info        jsonb NOT NULL DEFAULT '{}',
  error_category      text,
  error_detail        jsonb,
  provider_request_id text,
  provider_latency_ms int CHECK (provider_latency_ms >= 0),
  attempt             int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  superseded_by       uuid REFERENCES generation_jobs(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('completed','cancelled','failed') OR finished_at IS NOT NULL),
  CHECK (status <> 'generating' OR started_at IS NOT NULL)
);

-- At most one live generation per conversation => POST /messages 409 generation_in_progress.
CREATE UNIQUE INDEX one_active_generation_per_conversation
  ON generation_jobs (conversation_id)
  WHERE status IN ('pending','generating');

-- Reaper driving query: generating rows whose heartbeat went stale.
CREATE INDEX generation_jobs_heartbeat_idx
  ON generation_jobs (heartbeat_at)
  WHERE status = 'generating';

-- Per-user concurrency cap (§11.4 count of active rows).
CREATE INDEX generation_jobs_active_user_idx
  ON generation_jobs (user_id)
  WHERE status IN ('pending','generating');

CREATE INDEX generation_jobs_message_idx  ON generation_jobs (assistant_message_id);
CREATE INDEX generation_jobs_created_idx  ON generation_jobs (user_id, created_at DESC);

-- Deferred FKs from 0010 (the columns already exist there; this adds only the constraints).
ALTER TABLE quota_reservations
  ADD CONSTRAINT quota_reservations_generation_fk
  FOREIGN KEY (generation_id) REFERENCES generation_jobs(id) ON DELETE CASCADE;

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_generation_fk
  FOREIGN KEY (generation_id) REFERENCES generation_jobs(id) ON DELETE CASCADE;

ALTER TABLE quota_ledger
  ADD CONSTRAINT quota_ledger_generation_fk
  FOREIGN KEY (generation_id) REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- Grants (AGENTS §6.11). The 0010 block covered registry/conversations/accounting only; the
-- identity, settings, queue and error tables were never granted. No-op on the single-owner dev
-- role (owners bypass grants); required for the non-owner `aichat_app` VPS role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aichat_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      users, sessions, divisions, system_settings, jobs,
      generation_jobs
    TO aichat_app;

    -- Append-only: the app may write and read errors/logs, never rewrite them.
    GRANT SELECT, INSERT ON error_events TO aichat_app;
    REVOKE UPDATE, DELETE ON error_events FROM aichat_app;

    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aichat_app;
  END IF;
END $$;

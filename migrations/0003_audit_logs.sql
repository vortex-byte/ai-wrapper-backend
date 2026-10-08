-- 0003 — audit log: immutable, append-only (AGENTS §6.10 / PRD NFR-AUD-1)
-- Written in the same transaction as every admin mutation and security event.

CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  before          jsonb,
  after           jsonb,
  request_id      text,
  ip              inet,
  user_agent_hash text,
  prev_hash       char(64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(action)) > 0)
);
CREATE INDEX audit_logs_time_idx   ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);

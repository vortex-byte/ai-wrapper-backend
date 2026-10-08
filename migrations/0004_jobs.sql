-- 0004 — PostgreSQL-backed job queue (AGENTS §6.10, D-3)
-- Polled with SELECT ... FOR UPDATE SKIP LOCKED. `dedupe_key` makes scheduling idempotent.

CREATE TABLE jobs (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CHECK (length(btrim(type)) > 0)
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued';

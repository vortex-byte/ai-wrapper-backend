-- 0020 — usage_events: keep billing rows when a conversation is purged
--
-- `usage_events.generation_id` cascaded from `generation_jobs`, so hard-deleting a
-- long-deleted conversation also deleted the usage/cost source rows for every
-- generation it held. Reporting silently lost history. `quota_ledger` already uses
-- SET NULL for the same column; align `usage_events` with it.
--
-- Expand-only: the column becomes nullable and the FK switches to SET NULL.

ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_generation_id_generation_jobs_id_fk;

ALTER TABLE usage_events ALTER COLUMN generation_id DROP NOT NULL;

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_generation_id_generation_jobs_id_fk
  FOREIGN KEY (generation_id) REFERENCES generation_jobs (id) ON DELETE SET NULL;

-- 0015 — usage_daily: provider-reported vs estimated request counts
--
-- The admin usage report needs the share of settled generations whose token counts came
-- from the provider rather than a local estimate. Keeping it on `usage_daily` (not
-- `usage_events`) means the report survives a conversation purge. Additive only; existing
-- rows default to 0.

ALTER TABLE usage_daily
  ADD COLUMN IF NOT EXISTS provider_sourced_requests int NOT NULL DEFAULT 0;

ALTER TABLE usage_daily
  DROP CONSTRAINT IF EXISTS usage_daily_provider_sourced_requests_check;
ALTER TABLE usage_daily
  ADD CONSTRAINT usage_daily_provider_sourced_requests_check
  CHECK (provider_sourced_requests >= 0 AND provider_sourced_requests <= requests);

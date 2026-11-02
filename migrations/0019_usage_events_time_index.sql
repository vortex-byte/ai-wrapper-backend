-- 0019 — usage_events: indexes for the reporting dashboard queries
--
-- The reporting endpoints (`/api/admin/usage/*`) aggregate over `created_at`
-- windows. The existing indexes are all (scope, created_at DESC), so a query
-- with no scope filter (the super-admin dashboard's global summary, breakdown,
-- timeseries and per-model views) cannot use them efficiently.
--
-- `usage_events_time_idx` lets the planner range-scan by time alone, and covers
-- the `listRecentRequests` query (`ORDER BY created_at DESC LIMIT n`).

CREATE INDEX IF NOT EXISTS usage_events_time_idx ON usage_events (created_at DESC);

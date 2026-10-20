-- 0016 — autovacuum tuning for high-churn tables
--
-- These tables take many in-place updates between reads: streaming appends to
-- `message_parts`, quota counter updates on `quota_accounts`, and the queued → running →
-- done lifecycle on `jobs`. The default 20% dead-tuple threshold means lots of bloat and
-- late cleanup, so the per-table thresholds are lowered. These settings override
-- `postgresql.conf` and need no restart.

ALTER TABLE message_parts SET (
  autovacuum_vacuum_scale_factor   = 0.02,
  autovacuum_vacuum_threshold      = 1000,
  autovacuum_analyze_scale_factor  = 0.01,
  autovacuum_analyze_threshold     = 1000,
  autovacuum_vacuum_insert_threshold = 1000
);

ALTER TABLE quota_accounts SET (
  autovacuum_vacuum_scale_factor   = 0.02,
  autovacuum_vacuum_threshold      = 500,
  autovacuum_analyze_scale_factor  = 0.01,
  autovacuum_analyze_threshold     = 500
);

ALTER TABLE jobs SET (
  autovacuum_vacuum_scale_factor   = 0.05,
  autovacuum_vacuum_threshold      = 1000,
  autovacuum_analyze_scale_factor  = 0.02,
  autovacuum_analyze_threshold     = 1000
);

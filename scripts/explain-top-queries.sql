-- EXPLAIN ANALYZE review of the hot paths.
--
-- Run against staging with production-shaped data, never an empty test database (the planner
-- picks seq scans and tells you nothing). The SELECTs are read-only; the write plan is rolled back.
--
--   psql -d aichat \
--     -v user_id="'0192…'" -v conversation_id="'0192…'" -v account_id="'0192…'" \
--     -f scripts/explain-top-queries.sql
--
-- What to look for:
--   * `Index Scan` on the named index, not `Seq Scan`.
--   * `Rows Removed by Filter` close to the rows scanned (bad selectivity).
--   * `Buffers: shared read` dominating `hit` (cold cache, or the wrong index shape).
--   * `Sort Method: external merge` (raise `work_mem` for the review only).
--   * `Heap Fetches` on an index-only scan (needs a VACUUM).

\set ON_ERROR_STOP on
\timing off
\pset pager off

\echo '=== 1. Conversation list (keyset, newest first) ==='
-- Expect: Index Scan Backward using conversations_user_recent_idx.
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT id, title, message_count, COALESCE(last_message_at, created_at) AS sort_ts
  FROM conversations
 WHERE user_id = :user_id
   AND deleted_at IS NULL
 ORDER BY sort_ts DESC, id DESC
 LIMIT 30;

\echo '=== 2. Message page for one conversation (keyset on seq) ==='
-- Expect: Index Scan using messages_conversation_id_seq_key.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, seq, role, status, finish_reason, created_at
  FROM messages
 WHERE conversation_id = :conversation_id
   AND seq < 1000000
 ORDER BY seq DESC
 LIMIT 50;

\echo '=== 3. All parts for the loaded messages ==='
-- Expect: Index Scan using message_parts_message_id_position_key, no Sort (index order).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, message_id, position, type, status, text_content, data, file_id
  FROM message_parts
 WHERE message_id = ANY (
         SELECT id FROM messages
          WHERE conversation_id = :conversation_id
          ORDER BY seq DESC LIMIT 50
       )
 ORDER BY message_id, position;

\echo '=== 4. Active generation lookup + one-active-per-conversation guarantee ==='
-- Expect: Index Scan using one_active_generation_per_conversation.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, started_at, last_event_seq
  FROM generation_jobs
 WHERE conversation_id = :conversation_id
   AND status IN ('pending', 'generating');

\echo '=== 5. Job poll (SKIP LOCKED) ==='
-- Expect: Index Scan using jobs_due_idx with rows removed by the status predicate ≈ 0.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, payload, attempts, max_attempts
  FROM jobs
 WHERE status = 'queued' AND run_at <= now()
 ORDER BY run_at
 LIMIT 10
 FOR UPDATE SKIP LOCKED;

\echo '=== 6. Attachment expiry scan ==='
-- Expect: Index Scan using attachments_expiry_idx (partial index, small).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, storage_key
  FROM attachments
 WHERE expires_at < now()
   AND status NOT IN ('expired', 'deleted')
 LIMIT 100;

\echo '=== 7. Admin usage aggregate (usage_daily) ==='
-- Expect: Index Scan on the PK (day, user_id, model_id) for a narrow range, or a seq scan with
-- few rows. If a month-wide report seq-scans a large table, add a covering index on
-- (day, model_id) INCLUDE (requests, input_tokens, output_tokens, quota_tokens).
EXPLAIN (ANALYZE, BUFFERS)
SELECT day, sum(requests) AS requests, sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens, sum(quota_tokens) AS quota_tokens
  FROM usage_daily
 WHERE day >= current_date - 30
 GROUP BY day
 ORDER BY day;

\echo '=== 8. Error explorer (keyset, newest first) ==='
-- Expect: Index Scan Backward using error_events_time_idx.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, occurred_at, category, component, message
  FROM error_events
 WHERE occurred_at < now()
 ORDER BY occurred_at DESC
 LIMIT 50;

\echo '=== 9. Audit log search by target ==='
-- Expect: Index Scan Backward using audit_logs_target_idx.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, actor_user_id, action
  FROM audit_logs
 WHERE target_type = 'user' AND target_id = :user_id
 ORDER BY created_at DESC
 LIMIT 50;

\echo '=== 10. Quota reservation under contention (write plan, rolled back) ==='
-- Run this while a load test is in flight; the interesting number is "Rows Removed by Filter: 0"
-- and lock wait time. Production reserves by primary key, so filter the same way.
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
UPDATE quota_accounts
   SET reserved_tokens = reserved_tokens + 1000,
       updated_at = now()
 WHERE id = :account_id
   AND used_tokens + reserved_tokens + 1000 <= base_limit_tokens + adjustment_tokens
RETURNING id, used_tokens, reserved_tokens;
ROLLBACK;

\echo '=== 11. Index inventory: is anything unused, or missing? ==='
SELECT relname AS table,
       indexrelname AS index,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
 WHERE schemaname = 'public'
 ORDER BY idx_scan, pg_relation_size(indexrelid) DESC
 LIMIT 25;

\echo '=== 12. Table bloat signal (dead tuples vs live) ==='
SELECT relname,
       n_live_tup,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_autovacuum
  FROM pg_stat_user_tables
 WHERE schemaname = 'public'
 ORDER BY n_dead_tup DESC
 LIMIT 15;

\echo 'Review complete. Record the output with the run date and the data volume (row counts).'

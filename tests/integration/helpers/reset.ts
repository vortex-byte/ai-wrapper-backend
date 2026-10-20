import { getPool } from '@/db/index.ts';

/**
 * Reset identity data between integration tests, preserving platform seed rows.
 *
 * Deliberately uses ordered `DELETE`s rather than `TRUNCATE ... CASCADE`: `users` is
 * referenced by `system_settings.updated_by`, so a cascading truncate would also wipe
 * the `quota.timezone` default seeded by migration 0005. Safe only because the setup
 * refuses to run against a database whose name does not contain "test".
 *
 * Generation finalizers settle quota asynchronously, so a previous test's
 * finalizer may still be writing `usage_events` while this reset runs. FK violations
 * from that race are retried briefly — by the time the writer is done the deletes pass.
 */
const RESET_STATEMENTS = [
  'DELETE FROM audit_logs',
  'DELETE FROM file_extractions',
  'DELETE FROM attachments',
  'DELETE FROM sessions',
  'DELETE FROM jobs',
  'DELETE FROM usage_events',
  'DELETE FROM usage_daily',
  'DELETE FROM quota_ledger',
  'DELETE FROM quota_reservations',
  'DELETE FROM quota_accounts',
  'DELETE FROM quota_policies',
  'DELETE FROM generation_jobs',
  'DELETE FROM idempotency_keys',
  'DELETE FROM message_parts',
  'DELETE FROM messages',
  'DELETE FROM conversations',
  'DELETE FROM ai_model_prices',
  'DELETE FROM ai_models',
  'DELETE FROM ai_providers',
  'UPDATE system_settings SET updated_by = NULL WHERE updated_by IS NOT NULL',
  'DELETE FROM users',
] as const;

export async function resetDatabase(): Promise<void> {
  const pool = getPool();
  for (let attempt = 0; ; attempt++) {
    try {
      for (const statement of RESET_STATEMENTS) {
        await pool.query(statement);
      }
      return;
    } catch (err) {
      const pgErr = err as { code?: string };
      // 23503 foreign_key_violation: an async finalizer wrote quota rows mid-reset.
      if (pgErr.code === '23503' && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw err;
    }
  }
}

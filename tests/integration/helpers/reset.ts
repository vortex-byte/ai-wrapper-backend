import { getPool } from '@/db/index.ts';

/** Resets identity and conversational data between tests while preserving seed settings. */
const RESET_STATEMENTS = [
  'DELETE FROM audit_logs',
  'DELETE FROM error_events',
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
  'DELETE FROM divisions',
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

import { getPool } from '@/db/index.ts';

/**
 * Reset identity data between integration tests, preserving platform seed rows.
 *
 * Deliberately uses ordered `DELETE`s rather than `TRUNCATE ... CASCADE`: `users` is
 * referenced by `system_settings.updated_by`, so a cascading truncate would also wipe
 * the `quota.timezone` default seeded by migration 0005. Safe only because the setup
 * refuses to run against a database whose name does not contain "test".
 */
export async function resetDatabase(): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM audit_logs');
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM generation_jobs');
  await pool.query('DELETE FROM idempotency_keys');
  await pool.query('DELETE FROM message_parts');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM conversations');
  await pool.query('DELETE FROM ai_model_prices');
  await pool.query('DELETE FROM ai_models');
  await pool.query('DELETE FROM ai_providers');
  await pool.query('UPDATE system_settings SET updated_by = NULL WHERE updated_by IS NOT NULL');
  await pool.query('DELETE FROM users');
}

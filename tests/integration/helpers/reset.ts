import { getPool } from '@/db/index.ts';

function assertTestDatabaseUrl(url: string | undefined): void {
  if (!url) {
    throw new Error('[CRITICAL SAFETY] Ditolak: DATABASE_URL tidak terdefinisi.');
  }
  const dbName = (() => {
    try {
      return new URL(url).pathname.replace(/^\//, '');
    } catch {
      throw new Error('[CRITICAL SAFETY] Ditolak: Format DATABASE_URL tidak valid.');
    }
  })();
  if (!/test/i.test(dbName)) {
    throw new Error(
      `[CRITICAL SAFETY] Ditolak: resetDatabase() menolak beroperasi pada database "${dbName}". Nama database WAJIB mengandung kata "test"!`,
    );
  }
}

const RESET_STATEMENTS = [
  'DELETE FROM audit_logs',
  'DELETE FROM error_events',
  'DELETE FROM file_extractions',
  // Parts hold the FK to attachments, so they must go first.
  'DELETE FROM message_parts',
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
  'DELETE FROM messages',
  'DELETE FROM conversations',
  'DELETE FROM ai_model_prices',
  'DELETE FROM ai_models',
  'DELETE FROM ai_providers',
  "DELETE FROM system_settings WHERE key <> 'quota.timezone'",
  'UPDATE system_settings SET value = \'"Asia/Jakarta"\'::jsonb, version = 1, updated_by = NULL, updated_at = now() WHERE key = \'quota.timezone\'',
  'DELETE FROM users',
  'DELETE FROM divisions',
] as const;

export async function resetDatabase(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `[CRITICAL SAFETY] Ditolak: resetDatabase() hanya boleh dijalankan pada NODE_ENV='test' (saat ini: '${process.env.NODE_ENV}').`,
    );
  }

  assertTestDatabaseUrl(process.env.DATABASE_URL);

  const pool = getPool();
  const dbNameResult = await pool.query<{ current_database: string }>('SELECT current_database()');
  const currentDb = dbNameResult.rows[0]?.current_database ?? '';
  if (!/test/i.test(currentDb)) {
    throw new Error(
      `[CRITICAL SAFETY] Ditolak: Koneksi database aktif adalah "${currentDb}". Operasi reset dibatalkan karena nama database tidak mengandung kata "test"!`,
    );
  }

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

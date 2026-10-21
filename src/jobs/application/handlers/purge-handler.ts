import { getPool } from '@/db/pool.ts';
import { getLogger } from '@/observability/logger.ts';

export function createIdempotencyPurgeHandler() {
  return async (): Promise<{ purgedCount: number }> => {
    const pool = getPool();
    const res = await pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    const purgedCount = res.rowCount ?? 0;
    getLogger().info({ purgedCount }, 'purged expired idempotency keys');
    return { purgedCount };
  };
}

export function createSessionsPurgeHandler() {
  return async (): Promise<{ purgedCount: number }> => {
    const pool = getPool();
    const res = await pool.query(
      `DELETE FROM sessions WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    );
    const purgedCount = res.rowCount ?? 0;
    getLogger().info({ purgedCount }, 'purged expired sessions');
    return { purgedCount };
  };
}

export function createJobsPurgeHandler(retentionDays = 7) {
  return async (): Promise<{ purgedCount: number }> => {
    const pool = getPool();
    const res = await pool.query(
      `DELETE FROM jobs WHERE status IN ('done', 'dead') AND finished_at < now() - ($1 || ' days')::interval`,
      [retentionDays],
    );
    const purgedCount = res.rowCount ?? 0;
    getLogger().info({ purgedCount }, 'purged completed/dead jobs');
    return { purgedCount };
  };
}

import { Pool } from 'pg';
import { getConfig } from '../config/index.ts';
import { getLogger } from '../observability/logger.ts';

/**
 * One process-wide connection pool (PRD §24.4: `max` 20/node). The pool is the only
 * place `pg` is constructed; repositories receive a pool client or Drizzle handle.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      application_name: 'ai-chat-api',
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: config.ROLE === 'worker',
    });
    pool.on('error', (error) => {
      getLogger().error({ err: error }, 'idle database client error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

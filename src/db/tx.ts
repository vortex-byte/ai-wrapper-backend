import type { PoolClient } from 'pg';
import { getLogger } from '../observability/logger.ts';
import { getPool } from './pool.ts';

/**
 * Unit of Work (AGENTS §3.6). The use case owns the transaction boundary; this is the
 * only way to open one. Default isolation is READ COMMITTED (AGENTS §6.13). Network
 * I/O (provider calls, storage writes) must never happen inside `fn`.
 */
export interface TransactionContext {
  readonly client: PoolClient;
}

export interface TransactionOptions {
  /** Sets `app.user_id` for the P1 RLS policies (AGENTS §6.13). */
  readonly userId?: string;
}

export async function withTransaction<T>(
  fn: (tx: TransactionContext) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (options.userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', options.userId]);
    }
    const result = await fn({ client });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      getLogger().error({ err: rollbackError }, 'transaction rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

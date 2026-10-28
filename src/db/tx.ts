import type { PoolClient } from 'pg';
import { getLogger } from '../observability/logger.ts';
import { getPool } from './pool.ts';

export interface TransactionContext {
  readonly client: PoolClient;
}

export interface TransactionOptions {
  readonly userId?: string;
}

const savepointCounters = new WeakMap<SavepointClient, number>();

/** The subset of a pg client that savepoints need. */
export interface SavepointClient {
  query(text: string): Promise<unknown>;
}

/** Runs `fn` in a savepoint so a failed statement does not abort the surrounding transaction. */
export async function withSavepoint<T>(
  client: SavepointClient,
  fn: () => Promise<T>,
): Promise<T> {
  const next = (savepointCounters.get(client) ?? 0) + 1;
  savepointCounters.set(client, next);
  const name = `sp_${next}`;

  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
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

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPool } from './pool.ts';
import type { TransactionContext } from './tx.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;

let database: Database | undefined;

/** Typed Drizzle client over the shared pool. */
export function getDb(): Database {
  if (!database) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

/**
 * Resolve the Drizzle handle for a use case: the transaction's client when inside a
 * Unit of Work, otherwise the shared pool client. Repositories take an optional
 * `tx` and call this — they never open a transaction themselves (AGENTS §3.6).
 */
export function runDb(tx?: TransactionContext): Database {
  if (tx === undefined) return getDb();
  return drizzle(tx.client, { schema });
}

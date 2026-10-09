import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPool } from './pool.ts';
import type { TransactionContext } from './tx.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;

let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

export function runDb(tx?: TransactionContext): Database {
  if (tx === undefined) return getDb();
  return drizzle(tx.client, { schema });
}

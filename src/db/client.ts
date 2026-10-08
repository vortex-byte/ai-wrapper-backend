import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPool } from './pool.ts';
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

import type { PoolClient } from 'pg';
import { getLogger } from '../observability/logger.ts';
import {
  listMigrations,
  loadApplied,
  MIGRATIONS_TABLE,
  type MigrationFile,
} from './migrations.ts';
import { getPool } from './pool.ts';

const ADVISORY_LOCK_KEY = 'ai-chat:migrations';

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applyOne(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`Migration ${migration.filename} failed`, { cause: error });
  }
}

/**
 * Apply every pending migration, newest last, under an advisory lock. Runs as a
 * pre-deploy job — never on application boot. Editing an already
 * applied migration is rejected (checksum drift); add a new file instead.
 */
export async function runMigrations(dir?: string): Promise<MigrationRunResult> {
  const logger = getLogger();
  const migrations = await listMigrations(dir);
  const client = await getPool().connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    const applied = await loadApplied(client);

    for (const migration of migrations) {
      const row = applied.get(migration.version);
      if (row !== undefined && row.checksum !== migration.checksum) {
        throw new Error(
          `Checksum mismatch for ${migration.filename}: applied ${row.checksum.slice(0, 12)}…, ` +
            `on disk ${migration.checksum.slice(0, 12)}…. Migrations are forward-only — add a new migration.`,
        );
      }
    }

    const newlyApplied: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        skipped.push(migration.filename);
        continue;
      }
      await applyOne(client, migration);
      newlyApplied.push(migration.filename);
      logger.info({ migration: migration.filename }, 'migration applied');
    }

    return { applied: newlyApplied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]).catch(
      () => undefined,
    );
    client.release();
  }
}

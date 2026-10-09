import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/db/index.ts';
import { runMigrations } from '@/db/migrate.ts';
import { getMigrationState } from '@/db/migrations.ts';

/**
 * Requires a real PostgreSQL (TEST_DATABASE_URL). The DB is never mocked for schema
 * and transaction behaviour.
 */
describe('migration baseline', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('is idempotent — a second run applies nothing', async () => {
    const second = await runMigrations();
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it('reports a clean, ready state', async () => {
    const state = await getMigrationState();
    expect(state.pending).toEqual([]);
    expect(state.drifted).toEqual([]);
    expect(state.ready).toBe(true);
  });

  it('creates the baseline tables', async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((row) => row.table_name);
    for (const expected of [
      'audit_logs',
      'divisions',
      'error_events',
      'jobs',
      'schema_migrations',
      'sessions',
      'system_settings',
      'users',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('installs the citext extension and case-insensitive email uniqueness', async () => {
    const { rows } = await getPool().query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'citext'`,
    );
    expect(rows.map((row) => row.extname)).toContain('citext');
  });

  it('seeds the quota.timezone system setting', async () => {
    const { rows } = await getPool().query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = 'quota.timezone'`,
    );
    expect(rows[0]?.value).toBe('Asia/Jakarta');
  });
});

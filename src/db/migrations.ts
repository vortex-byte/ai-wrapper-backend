import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.ts';

/**
 * Discovery + integrity for forward-only SQL migrations (AGENTS §6.14). The runner
 * (`migrate.ts`) applies them under an advisory lock; this module only reads and
 * verifies files.
 */

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export const MIGRATIONS_TABLE = 'schema_migrations';

/** Resolved from this file's location: src/db/ → repo-root/migrations. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  const filenames = entries.filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const filename of filenames) {
    const match = /^(\d+)_([A-Za-z0-9_.-]+)\.sql$/.exec(filename);
    if (!match) {
      throw new Error(`Invalid migration filename "${filename}" (expected NNNN_name.sql)`);
    }
    const version = match[1] as string;
    const name = match[2] as string;
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version} (${filename})`);
    }
    seen.add(version);
    const sql = await fs.readFile(path.join(dir, filename), 'utf8');
    migrations.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }

  return migrations;
}

export interface MigrationState {
  readonly ready: boolean;
  readonly pending: readonly string[];
  readonly drifted: readonly string[];
  readonly appliedCount: number;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

export async function loadApplied(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: AppliedRow[] }>;
}): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/** Read-only status used by `/readyz` and the CLI. Never opens a transaction. */
export async function getMigrationState(dir?: string): Promise<MigrationState> {
  const migrations = await listMigrations(dir);
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ present: string | null }>(
      `SELECT to_regclass('public.' || $1)::text AS present`,
      [MIGRATIONS_TABLE],
    );
    if (rows[0]?.present === null || rows[0]?.present === undefined) {
      return { ready: false, pending: migrations.map((m) => m.filename), drifted: [], appliedCount: 0 };
    }

    const applied = await loadApplied(client);
    const pending = migrations.filter((m) => !applied.has(m.version)).map((m) => m.filename);
    const drifted = migrations
      .filter((m) => {
        const row = applied.get(m.version);
        return row !== undefined && row.checksum !== m.checksum;
      })
      .map((m) => m.filename);

    return { ready: pending.length === 0 && drifted.length === 0, pending, drifted, appliedCount: applied.size };
  } finally {
    client.release();
  }
}

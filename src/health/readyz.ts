import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/index.ts';
import { getMigrationState } from '../db/migrations.ts';
import { getPool } from '../db/pool.ts';

export interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Record<string, CheckResult>;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await getPool().query('SELECT 1');
    return { ok: true, detail: 'ok' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
  }
}

async function checkMigrations(): Promise<CheckResult> {
  try {
    const state = await getMigrationState();
    if (state.drifted.length > 0) {
      return { ok: false, detail: `checksum drift: ${state.drifted.join(', ')}` };
    }
    if (state.pending.length > 0) {
      return { ok: false, detail: `${state.pending.length} pending migration(s)` };
    }
    return { ok: true, detail: `${state.appliedCount} applied` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unavailable' };
  }
}

async function checkStorage(config: Config): Promise<CheckResult> {
  const root = path.resolve(config.STORAGE_LOCAL_ROOT);
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.access(root, constants.W_OK);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'not writable' };
  }

  try {
    const stats = await fs.statfs(root);
    const freeMib = (stats.bavail * stats.bsize) / (1024 * 1024);
    if (freeMib < config.STORAGE_MIN_FREE_MIB) {
      return { ok: false, detail: `low free space (${Math.round(freeMib)} MiB)` };
    }
    return { ok: true, detail: `${Math.round(freeMib)} MiB free` };
  } catch {
    // statfs may be unavailable on some platforms; writability already proved.
    return { ok: true, detail: 'writable' };
  }
}

export async function checkReadiness(config: Config): Promise<ReadinessReport> {
  const [database, migrations, storage] = await Promise.all([
    checkDatabase(),
    checkMigrations(),
    checkStorage(config),
  ]);
  const checks = { database, migrations, storage };
  return { ready: Object.values(checks).every((check) => check.ok), checks };
}

#!/usr/bin/env bun
import { parseBootstrapAdminArgs, runBootstrapAdmin } from './bootstrap-admin.ts';
import { ConfigError } from '../config/index.ts';
import { closePool } from '../db/index.ts';
import { getMigrationState } from '../db/migrations.ts';
import { runMigrations } from '../db/migrate.ts';
import { runExampleSeed } from '../db/seed.ts';
import { useMigrationDatabaseUrl } from './migration-env.ts';
import { runLiveSmoke } from './smoke-live.ts';

const USAGE = `Usage: bun run cli <command> [options]

Commands:
  migrate                      Apply pending SQL migrations (advisory-locked, forward-only)
  migrate:check                Verify the schema is current (read-only; non-zero exit when not)
  seed-example                 Insert documented example providers/models (never in production)
  bootstrap-admin --email <e>  Provision first admin user with a temporary password
  smoke-live --provider <key> Run a small live streaming smoke test
  help                         Show this help`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'migrate': {
      useMigrationDatabaseUrl();
      const result = await runMigrations();
      if (result.applied.length === 0) {
        console.log(`No pending migrations (${result.skipped.length} already applied).`);
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const filename of result.applied) console.log(`  ✓ ${filename}`);
      }
      return 0;
    }
    case 'migrate:check': {
      useMigrationDatabaseUrl();
      const state = await getMigrationState();
      if (state.drifted.length > 0) {
        console.error(`Migration checksum drift (forward-only — never edit an applied file):`);
        for (const filename of state.drifted) console.error(`  ✗ ${filename}`);
        return 1;
      }
      if (state.pending.length > 0) {
        console.error(`Schema is stale — ${state.pending.length} pending migration(s):`);
        for (const filename of state.pending) console.error(`  • ${filename}`);
        console.error('Run `bun run db:migrate` as the migrator role before starting the app.');
        return 1;
      }
      console.log(`Schema is current (${state.appliedCount} migration(s) applied).`);
      return 0;
    }
    case 'bootstrap-admin': {
      const parsed = parseBootstrapAdminArgs(rest);
      return runBootstrapAdmin(parsed);
    }
    case 'seed-example': {
      const result = await runExampleSeed();
      console.log(result.reason);
      return 0;
    }
    case 'smoke-live': {
      return await runLiveSmoke(rest);
    }
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(command === undefined ? USAGE : `Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} finally {
  await closePool();
}

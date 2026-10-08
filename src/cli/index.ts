#!/usr/bin/env bun
import { ConfigError } from '../config/index.ts';
import { closePool } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';

const USAGE = `Usage: bun run cli <command>

Commands:
  migrate    Apply pending SQL migrations (advisory-locked, forward-only)
  help       Show this help`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  switch (command) {
    case 'migrate': {
      const result = await runMigrations();
      if (result.applied.length === 0) {
        console.log(`No pending migrations (${result.skipped.length} already applied).`);
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const filename of result.applied) console.log(`  ✓ ${filename}`);
      }
      return 0;
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

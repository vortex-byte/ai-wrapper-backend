import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Integration-test bootstrap. Runs before any test module is imported so that
 * `getConfig()` (which is memoized) resolves `DATABASE_URL` to the **test** database.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    if (process.env[key] !== undefined) continue;
    let value = (match[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, '.env.test'));

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl === undefined || testUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests. Copy .env.example to .env and set it.',
  );
}

const databaseName = new URL(testUrl).pathname.replace(/^\//, '');
if (!/test/i.test(databaseName)) {
  throw new Error(
    `Refusing to run integration tests against database "${databaseName}" — its name must contain "test".`,
  );
}

process.env.DATABASE_URL = testUrl;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.NODE_ENV = 'test';

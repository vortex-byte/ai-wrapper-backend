import { describe, expect, it } from 'vitest';
import { useMigrationDatabaseUrl } from '@/cli/migration-env.ts';

const base = 'postgresql://aichat_app:app@127.0.0.1:5432/aichat';
const migrator = 'postgresql://aichat_migrator:migrator@127.0.0.1:5432/aichat';

describe('useMigrationDatabaseUrl', () => {
  it('overrides DATABASE_URL with the migrator credential when present', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: base,
      MIGRATION_DATABASE_URL: migrator,
    };
    expect(useMigrationDatabaseUrl(env)).toBe(true);
    expect(env['DATABASE_URL']).toBe(migrator);
  });

  it('leaves the app credential untouched when unset', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: base };
    expect(useMigrationDatabaseUrl(env)).toBe(false);
    expect(env['DATABASE_URL']).toBe(base);
  });

  it('treats a blank value as unset (env files use `KEY=`)', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: base,
      MIGRATION_DATABASE_URL: '  ',
    };
    expect(useMigrationDatabaseUrl(env)).toBe(false);
    expect(env['DATABASE_URL']).toBe(base);
  });
});

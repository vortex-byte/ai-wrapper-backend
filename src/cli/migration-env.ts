/**
 * Allows the migration CLI to connect using a dedicated migration database role.
 * When `MIGRATION_DATABASE_URL` is set, it overrides `DATABASE_URL` before
 * configuration initialization.
 */
export function useMigrationDatabaseUrl(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const migrationUrl = source['MIGRATION_DATABASE_URL'];
  if (migrationUrl === undefined || migrationUrl.trim() === '') return false;
  source['DATABASE_URL'] = migrationUrl;
  return true;
}

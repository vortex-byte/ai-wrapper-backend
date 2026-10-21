/** Overrides DATABASE_URL with MIGRATION_DATABASE_URL if present for migrations. */
export function useMigrationDatabaseUrl(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const migrationUrl = source['MIGRATION_DATABASE_URL'];
  if (migrationUrl === undefined || migrationUrl.trim() === '') return false;
  source['DATABASE_URL'] = migrationUrl;
  return true;
}

/**
 * The migration CLI may run as a **different database role** than the app (AGENTS.md §6.11):
 * `aichat_migrator` owns the DDL, while the running service connects as the least-privileged
 * `aichat_app`. The deploy guide sources `/etc/ai-chat/migrate.env` (which sets
 * `MIGRATION_DATABASE_URL`) and never exposes that credential to the app process
 * (IMPLEMENTATION_PLAN B4/B8).
 *
 * `MIGRATION_DATABASE_URL` is therefore consumed **only** here, in the CLI, and simply
 * overrides `DATABASE_URL` before `getConfig()` first runs. The server path never reads it, so
 * a DDL-capable credential can never end up in the long-running process.
 */
export function useMigrationDatabaseUrl(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const migrationUrl = source['MIGRATION_DATABASE_URL'];
  if (migrationUrl === undefined || migrationUrl.trim() === '') return false;
  source['DATABASE_URL'] = migrationUrl;
  return true;
}

/** Resolves provider secrets from configured environment variable names. */
export interface SecretResolver {
  /** `null` when the variable is unset or empty — callers surface `secret_not_configured`. */
  resolve(secretRef: string): string | null;
}

const FORBIDDEN_RESOLVER_SECRETS = new Set([
  'SESSION_SECRET',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
]);

/** Reads from a plain key/value map (the composition root passes `process.env`). */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: Record<string, string | undefined>) {}

  resolve(secretRef: string): string | null {
    if (FORBIDDEN_RESOLVER_SECRETS.has(secretRef.toUpperCase())) {
      return null;
    }
    const value = this.env[secretRef];
    if (value === undefined || value.trim() === '') return null;
    return value;
  }
}

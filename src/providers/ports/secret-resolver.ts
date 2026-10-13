/**
 * Resolves the value of a provider secret by the **name** of the environment variable
 * stored in `ai_providers.secret_ref`. The composition root supplies the
 * implementation so adapters never read `process.env` themselves.
 *
 * The returned value is never persisted, logged, or returned by any endpoint.
 */
export interface SecretResolver {
  /** `null` when the variable is unset or empty — callers surface `secret_not_configured`. */
  resolve(secretRef: string): string | null;
}

/** Reads from a plain key/value map (the composition root passes `process.env`). */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: Record<string, string | undefined>) {}

  resolve(secretRef: string): string | null {
    const value = this.env[secretRef];
    if (value === undefined || value.trim() === '') return null;
    return value;
  }
}

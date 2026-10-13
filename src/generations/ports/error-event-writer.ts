import type { TransactionContext } from '@/db/tx.ts';

/**
 * Sanitized system-error records for the admin error explorer (AGENTS §6.10 / PRD §21).
 *
 * Providers/generation failures are the first producer. The writer must never receive provider
 * response bodies, prompts, message text, keys or stack traces — only the normalized category and
 * small, already-public identifiers. `context` is for scalar metadata (status codes, attempts),
 * never free text from an upstream response.
 */
export interface ErrorEventEntry {
  readonly component: string;
  readonly category: string;
  readonly message: string;
  readonly requestId?: string | null;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly generationId?: string | null;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ErrorEventWriter {
  /** Append a sanitized error record. Never throws: telemetry must not break a request path. */
  record(entry: ErrorEventEntry, tx?: TransactionContext): Promise<void>;
}

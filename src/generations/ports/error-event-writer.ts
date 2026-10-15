import type { TransactionContext } from '@/db/tx.ts';

/**
 * Sanitized system-error records for error telemetry and reporting.
 *
 * The writer must never receive raw provider response bodies, prompts,
 * message text, keys or stack traces — only normalized categories and scalar metadata.
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

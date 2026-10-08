import type { TransactionContext } from '../../db/tx.ts';

/** One immutable audit record (AGENTS §6.10). Secrets are never placed in `before`/`after`. */
export interface AuditEntry {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgentHash?: string | null;
}

/**
 * Append-only writer. Callers must pass the same `tx` as the mutation they are
 * auditing so the record and the change commit together (NFR-AUD-1).
 */
export interface AuditLogRepository {
  append(entry: AuditEntry, tx?: TransactionContext): Promise<void>;
}

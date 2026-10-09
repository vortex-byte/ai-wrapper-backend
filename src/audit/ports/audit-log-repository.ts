import type { TransactionContext } from '@/db/tx.ts';

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

export interface AuditLogRepository {
  append(entry: AuditEntry, tx?: TransactionContext): Promise<void>;
}

import { runDb } from '@/db/client.ts';
import { auditLogs } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { AuditEntry, AuditLogRepository } from '../ports/audit-log-repository.ts';

export class DrizzleAuditLogRepository implements AuditLogRepository {
  async append(entry: AuditEntry, tx?: TransactionContext): Promise<void> {
    await runDb(tx).insert(auditLogs).values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      requestId: entry.requestId ?? null,
      ip: entry.ip ?? null,
      userAgentHash: entry.userAgentHash ?? null,
    });
  }
}

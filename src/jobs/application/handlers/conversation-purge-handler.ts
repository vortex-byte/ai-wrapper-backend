import type { Clock } from '@/clock/index.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import { withTransaction, type TransactionContext } from '@/db/tx.ts';
import { getLogger } from '@/observability/logger.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';

const BATCH = 50;
const DAY_MS = 86_400_000;

export interface ConversationPurgeDeps {
  readonly conversations: Pick<
    ConversationRepository,
    'findPurgeableIds' | 'attachmentStorageKeysFor' | 'hardDelete'
  >;
  readonly storage: Pick<StorageProviderPort, 'delete'>;
  readonly clock: Clock;
  readonly retentionDays: number;
  readonly runInTransaction?:
    | (<T>(fn: (tx: TransactionContext) => Promise<T>) => Promise<T>)
    | undefined;
}

export function createConversationPurgeHandler(deps: ConversationPurgeDeps) {
  return async (): Promise<{ purgedCount: number }> => {
    const cutoff = new Date(deps.clock.now().getTime() - deps.retentionDays * DAY_MS);
    const run = deps.runInTransaction ?? withTransaction;
    let purgedCount = 0;

    for (;;) {
      const batch = await run(async (tx) => {
        const ids = await deps.conversations.findPurgeableIds(cutoff, BATCH, tx);
        if (ids.length === 0) return null;
        const attachments = await deps.conversations.attachmentStorageKeysFor(ids, tx);
        const deleted = await deps.conversations.hardDelete(ids, tx);
        return { deleted, attachments };
      });

      if (batch === null) break;

      for (const attachment of batch.attachments) {
        try {
          await deps.storage.delete(attachment.storageKey);
        } catch (err) {
          getLogger().warn(
            { err, conversationId: attachment.conversationId },
            'failed to delete blob for purged conversation (reconciliation will retry)',
          );
        }
      }

      purgedCount += batch.deleted;
      if (batch.deleted < BATCH) break;
    }

    if (purgedCount > 0) {
      getLogger().info({ purgedCount }, 'purged soft-deleted conversations');
    }
    return { purgedCount };
  };
}

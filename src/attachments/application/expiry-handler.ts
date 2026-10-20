import { getLogger } from '@/observability/logger.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import type { Clock } from '@/clock/index.ts';

/**
 * Attachment lifecycle jobs:
 * - `attachments.expire`: tombstone rows past `expires_at`, then delete their blobs.
 * - `attachments.purge_orphans`: uploads never attached to a message within the grace window are
 *   expired early, so failed sends don't leak disk.
 *
 * Rows are marked before bytes are deleted, so a crash leaves at worst a tombstone whose blob is
 * re-deleted on the next run. Neither job holds a transaction while deleting.
 */

const ORPHAN_GRACE_MINUTES = 60;
const BATCH = 100;

export function createAttachmentsExpiryHandler(input: {
  readonly attachments: AttachmentRepository;
  readonly storage: StorageProviderPort;
  readonly clock: Clock;
}) {
  return async (): Promise<{ expiredCount: number }> => {
    const due = await input.attachments.findDueForExpiry(input.clock.now(), BATCH);
    let expiredCount = 0;

    for (const attachment of due) {
      await input.attachments.markDeleted([attachment.id]);
      await input.storage.delete(attachment.storageKey);
      expiredCount += 1;
    }

    if (expiredCount > 0) {
      getLogger().info({ expiredCount }, 'expired attachments');
    }
    return { expiredCount };
  };
}

export function createAttachmentsOrphanHandler(input: {
  readonly attachments: AttachmentRepository;
  readonly storage: StorageProviderPort;
  readonly clock: Clock;
}) {
  return async (): Promise<{ purgedCount: number }> => {
    const cutoff = new Date(input.clock.now().getTime() - ORPHAN_GRACE_MINUTES * 60_000);
    const orphans = await input.attachments.findOrphans(cutoff, BATCH);
    let purgedCount = 0;

    for (const attachment of orphans) {
      await input.attachments.markDeleted([attachment.id]);
      await input.storage.delete(attachment.storageKey);
      purgedCount += 1;
    }

    if (purgedCount > 0) {
      getLogger().info({ purgedCount }, 'purged orphan attachments');
    }
    return { purgedCount };
  };
}

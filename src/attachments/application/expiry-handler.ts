import { getLogger } from '@/observability/logger.ts';
import type { Attachment } from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import type { ProviderFileCleaner } from '@/provider-file-cleaner.ts';
import type { Clock } from '@/clock/index.ts';

/** Attachment lifecycle jobs: tombstones expired/orphaned uploads and removes their blobs. */

const ORPHAN_GRACE_MINUTES = 60;
const BATCH = 100;

/** Provider copy recorded when an artifact was hydrated; absent for input uploads. */
function providerRef(attachment: Attachment): {
  providerFileId: string;
  providerKey: string | null;
} | null {
  const providerFileId = attachment.metadata['providerFileId'];
  if (typeof providerFileId !== 'string' || providerFileId === '') return null;
  const providerKey = attachment.metadata['providerKey'];
  return {
    providerFileId,
    providerKey: typeof providerKey === 'string' && providerKey !== '' ? providerKey : null,
  };
}

export function createAttachmentsExpiryHandler(input: {
  readonly attachments: AttachmentRepository;
  readonly storage: StorageProviderPort;
  readonly providerFiles?: Pick<ProviderFileCleaner, 'deleteFile'> | undefined;
  readonly clock: Clock;
}) {
  return async (): Promise<{ expiredCount: number }> => {
    const due = await input.attachments.findDueForExpiry(input.clock.now(), BATCH);
    let expiredCount = 0;

    for (const attachment of due) {
      await input.attachments.markDeleted([attachment.id]);
      await input.storage.delete(attachment.storageKey);
      await deleteProviderCopy(input.providerFiles, attachment);
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
  readonly providerFiles?: Pick<ProviderFileCleaner, 'deleteFile'> | undefined;
  readonly clock: Clock;
}) {
  return async (): Promise<{ purgedCount: number }> => {
    const cutoff = new Date(input.clock.now().getTime() - ORPHAN_GRACE_MINUTES * 60_000);
    const orphans = await input.attachments.findOrphans(cutoff, BATCH);
    let purgedCount = 0;

    for (const attachment of orphans) {
      await input.attachments.markDeleted([attachment.id]);
      await input.storage.delete(attachment.storageKey);
      await deleteProviderCopy(input.providerFiles, attachment);
      purgedCount += 1;
    }

    if (purgedCount > 0) {
      getLogger().info({ purgedCount }, 'purged orphan attachments');
    }
    return { purgedCount };
  };
}

/** Best-effort: the local tombstone already committed, so a provider failure only logs. */
async function deleteProviderCopy(
  providerFiles: Pick<ProviderFileCleaner, 'deleteFile'> | undefined,
  attachment: Attachment,
): Promise<void> {
  if (providerFiles === undefined) return;
  const ref = providerRef(attachment);
  if (ref === null) return;
  try {
    await providerFiles.deleteFile(ref);
  } catch (err) {
    getLogger().warn(
      { err, attachmentId: attachment.id, component: 'attachments-expiry' },
      'provider copy delete failed',
    );
  }
}

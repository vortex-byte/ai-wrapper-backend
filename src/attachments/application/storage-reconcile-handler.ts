import { getLogger } from '@/observability/logger.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import type { Clock } from '@/clock/index.ts';

/** Periodic sweep comparing storage blobs with attachment records to detect and clean drift. */

const DEFAULT_PREFIX = 'files/';
const KEY_PAGE_SIZE = 500;
const MAX_LOGGED_KEYS = 20;

export interface StorageReconcileResult {
  /** Blobs present in storage but absent from database (deleted). */
  readonly orphanedBlobsDeleted: number;
  /** Database records whose storage blob is missing (reported). */
  readonly missingBlobs: number;
  /** Storage keys scanned under prefix. */
  readonly scannedKeys: number;
}

export function createStorageReconcileHandler(input: {
  readonly storage: StorageProviderPort;
  readonly attachments: AttachmentRepository;
  readonly clock: Clock;
  readonly prefix?: string | undefined;
}): () => Promise<StorageReconcileResult> {
  return async (): Promise<StorageReconcileResult> => {
    const storedKeys = await input.storage.listKeys(input.prefix ?? DEFAULT_PREFIX);
    const stored = new Set(storedKeys);

    const dbKeys = new Set<string>();
    const missing: string[] = [];
    let cursor: string | null = null;

    for (;;) {
      const page = await input.attachments.listStorageKeys(cursor, KEY_PAGE_SIZE);
      for (const key of page.keys) {
        dbKeys.add(key);
        if (!stored.has(key)) missing.push(key);
      }
      if (page.nextCursor === null || page.keys.length === 0) break;
      cursor = page.nextCursor;
    }

    let orphanedBlobsDeleted = 0;
    for (const key of storedKeys) {
      if (dbKeys.has(key)) continue;
      await input.storage.delete(key);
      orphanedBlobsDeleted += 1;
    }

    const missingBlobs = missing.length;
    const at = input.clock.now().toISOString();

    if (missingBlobs > 0) {
      getLogger().warn(
        { missingBlobs, storageKeys: missing.slice(0, MAX_LOGGED_KEYS), at },
        'storage reconcile: database rows reference blobs missing from storage',
      );
    }
    getLogger().info(
      { scannedKeys: storedKeys.length, orphanedBlobsDeleted, missingBlobs, at },
      'storage reconcile complete',
    );

    return { orphanedBlobsDeleted, missingBlobs, scannedKeys: storedKeys.length };
  };
}

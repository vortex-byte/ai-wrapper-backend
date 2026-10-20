import { getLogger } from '@/observability/logger.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import type { Clock } from '@/clock/index.ts';

/**
 * Weekly `storage.reconcile` sweep: compares the blobs under the storage prefix with the
 * `attachments.storage_key` values and reports drift in both directions.
 *
 * - on disk, absent from the DB => orphan blob, deleted (nothing references it);
 * - in the DB, absent from disk => missing blob, reported only. The database is the source of
 *   truth and a human decides, because the blob may reappear from a backup.
 *
 * Idempotent, and no transaction is held while deleting bytes.
 */

const DEFAULT_PREFIX = 'files/';
/** Keyset page size for the DB scan — bounded so a large `attachments` table is never loaded at once. */
const KEY_PAGE_SIZE = 500;
/** Cap on keys echoed into the warning so a storage outage cannot flood the log. */
const MAX_LOGGED_KEYS = 20;

export interface StorageReconcileResult {
  /** Blobs present on disk but absent from the DB — deleted by this run. */
  readonly orphanedBlobsDeleted: number;
  /** DB rows whose blob is absent on disk — reported, never deleted here. */
  readonly missingBlobs: number;
  /** Blobs enumerated on disk under the prefix (the storage side of the comparison). */
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

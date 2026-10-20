import type { TransactionContext } from '@/db/tx.ts';
import type { Attachment, AttachmentStatus, FileExtraction } from '../domain/attachment.ts';

/** Repository seam for attachments + extractions. Takes `AuthContext`-scoped user ids. */
export interface AttachmentRepository {
  insert(attachment: Attachment, extraction?: FileExtraction | null): Promise<void>;

  findByIdAndUser(attachmentId: string, userId: string): Promise<Attachment | null>;

  /**
   * Links uploaded attachments to a user message.
   * Once linked (`message_id IS NOT NULL`), the orphan purger will never delete them.
   */
  attachToMessage(
    attachmentIds: readonly string[],
    messageId: string,
    tx?: TransactionContext,
  ): Promise<void>;

  updateStatus(input: {
    readonly attachmentId: string;
    readonly status: AttachmentStatus;
    readonly errorCode?: string | null | undefined;
  }): Promise<void>;

  upsertExtraction(extraction: FileExtraction): Promise<void>;

  findExtraction(attachmentId: string): Promise<FileExtraction | null>;

  /** Due rows that are not tombstoned yet. */
  findDueForExpiry(asOf: Date, limit: number): Promise<Attachment[]>;

  findOrphans(olderThan: Date, limit: number): Promise<Attachment[]>;

  /**
   * Keyset page over every `storage_key` that still owns a blob, ordered ascending, for the
   * weekly `storage.reconcile` sweep. Tombstoned rows (`deleted`, `expired`) are excluded: their
   * bytes are gone, so listing them would hide their orphans from the sweep and report them as
   * missing blobs on every run. `cursor` is the last key of the previous page (`null` for the
   * first); `nextCursor` is `null` once the last page is reached.
   */
  listStorageKeys(
    cursor: string | null,
    limit: number,
  ): Promise<{ keys: string[]; nextCursor: string | null }>;

  markDeleted(attachmentIds: readonly string[]): Promise<void>;
}

import type { TransactionContext } from '@/db/tx.ts';
import type { Attachment, AttachmentStatus, FileExtraction } from '../domain/attachment.ts';

/** Repository seam for attachments + extractions. Takes `AuthContext`-scoped user ids. */
export interface AttachmentRepository {
  insert(
    attachment: Attachment,
    extraction?: FileExtraction | null,
    tx?: TransactionContext,
  ): Promise<void>;

  findByIdAndUser(attachmentId: string, userId: string): Promise<Attachment | null>;

  /**
   * Owner-scoped batch read for hydrating message parts. Tombstoned rows are included: the read
   * API reports them as `expired` instead of losing the part's file entirely.
   */
  findManyByIdsForUser(attachmentIds: readonly string[], userId: string): Promise<Attachment[]>;

  /** Links uploaded attachments to a message. */
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

  /** Keyset page over non-tombstoned storage keys for periodic reconciliation sweeps. */
  listStorageKeys(
    cursor: string | null,
    limit: number,
  ): Promise<{ keys: string[]; nextCursor: string | null }>;

  markDeleted(attachmentIds: readonly string[]): Promise<void>;
}

import { and, eq, gt, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { attachments, fileExtractions } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import type { Attachment, AttachmentStatus, FileExtraction } from '../domain/attachment.ts';
import type { AttachmentRepository } from '../ports/attachment-repository.ts';

type AttachmentRow = typeof attachments.$inferSelect;
type ExtractionRow = typeof fileExtractions.$inferSelect;

function toDomain(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    messagePartId: row.messagePartId,
    origin: row.origin as Attachment['origin'],
    kind: row.kind as Attachment['kind'],
    displayName: row.displayName,
    declaredMime: row.declaredMime,
    detectedMime: row.detectedMime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageProvider: row.storageProvider,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    status: row.status as AttachmentStatus,
    errorCode: row.errorCode,
    width: row.width,
    height: row.height,
    pageCount: row.pageCount,
    metadata: (row.metadata ?? {}) as Readonly<Record<string, unknown>>,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function toExtractionDomain(row: ExtractionRow): FileExtraction {
  return {
    fileId: row.fileId,
    status: row.status as FileExtraction['status'],
    extractor: row.extractor,
    text: row.text,
    charCount: row.charCount,
    tokenEstimate: row.tokenEstimate,
    truncated: row.truncated,
    pageCount: row.pageCount,
    errorCode: row.errorCode,
  };
}

const attachmentColumns = {
  id: attachments.id,
  ownerUserId: attachments.ownerUserId,
  conversationId: attachments.conversationId,
  messageId: attachments.messageId,
  messagePartId: attachments.messagePartId,
  origin: attachments.origin,
  kind: attachments.kind,
  displayName: attachments.displayName,
  declaredMime: attachments.declaredMime,
  detectedMime: attachments.detectedMime,
  sizeBytes: attachments.sizeBytes,
  sha256: attachments.sha256,
  storageProvider: attachments.storageProvider,
  storageBucket: attachments.storageBucket,
  storageKey: attachments.storageKey,
  status: attachments.status,
  errorCode: attachments.errorCode,
  width: attachments.width,
  height: attachments.height,
  pageCount: attachments.pageCount,
  metadata: attachments.metadata,
  expiresAt: attachments.expiresAt,
  createdAt: attachments.createdAt,
  deletedAt: attachments.deletedAt,
  pinnedAt: attachments.pinnedAt,
};

const extractionColumns = {
  fileId: fileExtractions.fileId,
  status: fileExtractions.status,
  extractor: fileExtractions.extractor,
  text: fileExtractions.text,
  charCount: fileExtractions.charCount,
  tokenEstimate: fileExtractions.tokenEstimate,
  truncated: fileExtractions.truncated,
  pageCount: fileExtractions.pageCount,
  errorCode: fileExtractions.errorCode,
  createdAt: fileExtractions.createdAt,
};

export class DrizzleAttachmentRepository implements AttachmentRepository {
  async insert(
    attachment: Attachment,
    extraction?: FileExtraction | null,
    tx?: TransactionContext,
  ): Promise<void> {
    const db = runDb(tx);
    await db.insert(attachments).values({
      id: attachment.id,
      ownerUserId: attachment.ownerUserId,
      conversationId: attachment.conversationId,
      messageId: attachment.messageId,
      messagePartId: attachment.messagePartId,
      origin: attachment.origin,
      kind: attachment.kind,
      displayName: attachment.displayName,
      declaredMime: attachment.declaredMime,
      detectedMime: attachment.detectedMime,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      storageProvider: attachment.storageProvider,
      storageBucket: attachment.storageBucket,
      storageKey: attachment.storageKey,
      status: attachment.status,
      errorCode: attachment.errorCode,
      width: attachment.width,
      height: attachment.height,
      pageCount: attachment.pageCount,
      metadata: attachment.metadata,
      expiresAt: attachment.expiresAt,
    });
    if (extraction !== undefined && extraction !== null) {
      await db.insert(fileExtractions).values({
        fileId: extraction.fileId,
        status: extraction.status,
        extractor: extraction.extractor,
        text: extraction.text,
        charCount: extraction.charCount,
        tokenEstimate: extraction.tokenEstimate,
        truncated: extraction.truncated,
        pageCount: extraction.pageCount,
        errorCode: extraction.errorCode,
      });
    }
  }

  async findByIdAndUser(attachmentId: string, userId: string): Promise<Attachment | null> {
    const rows = await runDb()
      .select(attachmentColumns)
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.ownerUserId, userId)))
      .limit(1);
    const row = rows[0];
    return row !== undefined ? toDomain(row) : null;
  }

  async attachToMessage(
    attachmentIds: readonly string[],
    messageId: string,
    tx?: TransactionContext,
  ): Promise<void> {
    if (attachmentIds.length === 0) return;
    const uniqueIds = Array.from(new Set(attachmentIds));
    const updated = await runDb(tx)
      .update(attachments)
      .set({ messageId })
      .where(
        and(
          inArray(attachments.id, uniqueIds),
          isNull(attachments.messageId),
          isNull(attachments.deletedAt),
        ),
      )
      .returning({ id: attachments.id });
    if (updated.length !== uniqueIds.length) {
      throw new AppError(
        'conflict',
        'One or more attachments are already attached, deleted, or missing.',
      );
    }
  }

  async updateStatus(input: {
    readonly attachmentId: string;
    readonly status: AttachmentStatus;
    readonly errorCode?: string | null | undefined;
  }): Promise<void> {
    await runDb()
      .update(attachments)
      .set({
        status: input.status,
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      })
      .where(eq(attachments.id, input.attachmentId));
  }

  async upsertExtraction(extraction: FileExtraction): Promise<void> {
    await runDb()
      .insert(fileExtractions)
      .values({
        fileId: extraction.fileId,
        status: extraction.status,
        extractor: extraction.extractor,
        text: extraction.text,
        charCount: extraction.charCount,
        tokenEstimate: extraction.tokenEstimate,
        truncated: extraction.truncated,
        pageCount: extraction.pageCount,
        errorCode: extraction.errorCode,
      })
      .onConflictDoUpdate({
        target: fileExtractions.fileId,
        set: {
          status: extraction.status,
          extractor: extraction.extractor,
          text: extraction.text,
          charCount: extraction.charCount,
          tokenEstimate: extraction.tokenEstimate,
          truncated: extraction.truncated,
          pageCount: extraction.pageCount,
          errorCode: extraction.errorCode,
        },
      });
  }

  async findExtraction(attachmentId: string): Promise<FileExtraction | null> {
    const rows = await runDb()
      .select(extractionColumns)
      .from(fileExtractions)
      .where(eq(fileExtractions.fileId, attachmentId))
      .limit(1);
    const row = rows[0];
    return row !== undefined ? toExtractionDomain(row) : null;
  }

  async findDueForExpiry(asOf: Date, limit: number): Promise<Attachment[]> {
    const rows = await runDb()
      .select(attachmentColumns)
      .from(attachments)
      .where(
        and(
          lt(attachments.expiresAt, asOf),
          ne(attachments.status, 'expired'),
          ne(attachments.status, 'deleted'),
          isNull(attachments.pinnedAt),
        ),
      )
      .limit(limit);
    return rows.map(toDomain);
  }

  async findOrphans(olderThan: Date, limit: number): Promise<Attachment[]> {
    const rows = await runDb()
      .select(attachmentColumns)
      .from(attachments)
      .where(
        and(
          isNull(attachments.messageId),
          lt(attachments.createdAt, olderThan),
          ne(attachments.status, 'deleted'),
        ),
      )
      .limit(limit);
    return rows.map(toDomain);
  }

  async listStorageKeys(
    cursor: string | null,
    limit: number,
  ): Promise<{ keys: string[]; nextCursor: string | null }> {
    // Only rows that still own a blob. Tombstoned rows (`deleted`, `expired`) have had their
    // bytes removed by the expiry job: listing them would both (a) hide their orphans from the
    // sweep and (b) report every one of them as a missing blob on the next run.
    const liveOwners = and(
      isNull(attachments.deletedAt),
      notInArray(attachments.status, ['deleted', 'expired']),
    );
    const rows = await runDb()
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(cursor === null ? liveOwners : and(liveOwners, gt(attachments.storageKey, cursor)))
      .orderBy(attachments.storageKey)
      .limit(limit);

    const keys = rows.map((row) => row.storageKey);
    const lastKey = keys[keys.length - 1];
    const nextCursor = keys.length === limit && lastKey !== undefined ? lastKey : null;
    return { keys, nextCursor };
  }

  async markDeleted(attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    await runDb()
      .update(attachments)
      .set({ status: 'deleted', deletedAt: sql`now()` })
      .where(inArray(attachments.id, [...attachmentIds]));
  }
}

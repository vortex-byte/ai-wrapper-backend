import { and, eq, gt, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { attachments, fileExtractions } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
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

export class DrizzleAttachmentRepository implements AttachmentRepository {
  async insert(attachment: Attachment, extraction?: FileExtraction | null): Promise<void> {
    await runDb().transaction(async (tx) => {
      await tx.insert(attachments).values({
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
        await tx.insert(fileExtractions).values({
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
    });
  }

  async findByIdAndUser(attachmentId: string, userId: string): Promise<Attachment | null> {
    const rows = await runDb()
      .select()
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
    await runDb(tx)
      .update(attachments)
      .set({ messageId })
      .where(inArray(attachments.id, [...attachmentIds]));
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
      .select()
      .from(fileExtractions)
      .where(eq(fileExtractions.fileId, attachmentId))
      .limit(1);
    const row = rows[0];
    return row !== undefined ? toExtractionDomain(row) : null;
  }

  async findDueForExpiry(asOf: Date, limit: number): Promise<Attachment[]> {
    const rows = await runDb()
      .select()
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
      .select()
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

import { describe, expect, it } from 'vitest';
import { AttachmentService } from '@/attachments/application/attachment-service.ts';
import type { Attachment, FileExtraction } from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { Config } from '@/config/index.ts';

class FakeStorage implements StorageProviderPort {
  readonly kind = 'fake';
  readonly blobs = new Map<string, Uint8Array>();

  async putStream(): Promise<{ key: string; sizeBytes: number; sha256: string }> {
    throw new Error('not used');
  }

  async getStream(key: string): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number }> {
    const bytes = this.blobs.get(key) ?? new Uint8Array();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { stream, sizeBytes: bytes.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async delete(): Promise<void> {}

  async listKeys(): Promise<string[]> {
    return [];
  }
}

class FakeAttachmentRepo implements AttachmentRepository {
  readonly attachments = new Map<string, Attachment>();
  readonly extractions = new Map<string, FileExtraction>();

  async insert(attachment: Attachment, extraction?: FileExtraction | null): Promise<void> {
    this.attachments.set(attachment.id, attachment);
    if (extraction) this.extractions.set(extraction.fileId, extraction);
  }

  async findByIdAndUser(attachmentId: string, userId: string): Promise<Attachment | null> {
    const att = this.attachments.get(attachmentId);
    if (!att || att.ownerUserId !== userId) return null;
    return att;
  }

  async attachToMessage(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async upsertExtraction(): Promise<void> {}
  async findExtraction(attachmentId: string): Promise<FileExtraction | null> {
    return this.extractions.get(attachmentId) ?? null;
  }
  async findDueForExpiry(): Promise<Attachment[]> {
    return [];
  }
  async findOrphans(): Promise<Attachment[]> {
    return [];
  }
  async listStorageKeys(): Promise<{ keys: string[]; nextCursor: string | null }> {
    return { keys: [], nextCursor: null };
  }
  async markDeleted(): Promise<void> {}
}

const dummyConfig = {
  FILE_RETENTION_HOURS: 48,
  STORAGE_MIN_FREE_MIB: 100,
} as unknown as Config;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    ownerUserId: 'u-1',
    conversationId: 'c-1',
    messageId: null,
    messagePartId: null,
    origin: 'input',
    kind: 'image',
    displayName: 'photo.png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
    storageProvider: 'fake',
    storageBucket: null,
    storageKey: 'files/2026-10/att-1',
    status: 'ready',
    errorCode: null,
    width: 200,
    height: 100,
    pageCount: null,
    metadata: {},
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('AttachmentService.resolveParts', () => {
  it('resolves image attachments to ImagePart with lazy reader', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    storage.blobs.set('files/2026-10/att-1', new TextEncoder().encode('fake-image-bytes'));
    await attachments.insert(makeAttachment({ id: 'att-1', kind: 'image' }));

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    const result = await service.resolveParts(['att-1'], 'u-1');
    expect(result.parts).toHaveLength(1);
    expect(result.attachments).toHaveLength(1);

    const part = result.parts[0];
    expect(part?.type).toBe('image');
    if (part?.type === 'image') {
      expect(part.file.name).toBe('photo.png');
      expect(part.file.mimeType).toBe('image/png');
      expect(part.file.width).toBe(200);
      expect(part.file.height).toBe(100);

      const bytes = await part.file.read();
      expect(new TextDecoder().decode(bytes)).toBe('fake-image-bytes');
    }
  });

  it('resolves document attachments to DocumentPart carrying extracted text', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    await attachments.insert(
      makeAttachment({
        id: 'att-doc',
        kind: 'document',
        displayName: 'spec.pdf',
        detectedMime: 'application/pdf',
      }),
      {
        fileId: 'att-doc',
        status: 'done',
        extractor: 'anydoc',
        text: 'This is the document content.',
        charCount: 29,
        tokenEstimate: 7,
        truncated: false,
        pageCount: 1,
        errorCode: null,
      },
    );

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    const result = await service.resolveParts(['att-doc'], 'u-1');
    expect(result.parts).toHaveLength(1);

    const part = result.parts[0];
    expect(part?.type).toBe('document');
    if (part?.type === 'document') {
      expect(part.file.name).toBe('spec.pdf');
      expect(part.extractedText).toBe('This is the document content.');
      expect(part.preferNative).toBe(true);
    }
  });

  it('rejects access to another user attachment with not_found', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    await attachments.insert(makeAttachment({ id: 'att-other', ownerUserId: 'u-victim' }));

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    await expect(service.resolveParts(['att-other'], 'u-attacker')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects unready files with file_not_ready', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    await attachments.insert(makeAttachment({ id: 'att-pending', status: 'validating' }));

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    await expect(service.resolveParts(['att-pending'], 'u-1')).rejects.toMatchObject({
      code: 'file_not_ready',
    });
  });

  it('refuses an attachment belonging to another conversation', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    await attachments.insert(makeAttachment({ id: 'att-other-conv', conversationId: 'c-2' }));

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    await expect(
      service.resolveParts(['att-other-conv'], 'u-1', { conversationId: 'c-1' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a file already bound to a message when unbound is required', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    await attachments.insert(makeAttachment({ id: 'att-bound', messageId: 'm-1' }));

    const service = new AttachmentService(
      dummyConfig,
      storage,
      attachments,
      {} as ConversationRepository,
      { now: () => new Date() },
      { uuidv7: () => 'id' },
    );

    await expect(
      service.resolveParts(['att-bound'], 'u-1', { conversationId: 'c-1', requireUnbound: true }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The retry path re-reads its own message's files, so binding is allowed there.
    await expect(
      service.resolveParts(['att-bound'], 'u-1', { conversationId: 'c-1' }),
    ).resolves.toMatchObject({ attachments: [{ id: 'att-bound' }] });
  });
});

import { describe, expect, it } from 'vitest';
import { AttachmentService } from '@/attachments/application/attachment-service.ts';
import type { Attachment, AttachmentStatus } from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { Config } from '@/config/index.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';

class FakeAttachmentRepo implements AttachmentRepository {
  readonly rows: Attachment[] = [];
  calls = 0;

  async insert(): Promise<void> {}
  async findByIdAndUser(): Promise<Attachment | null> {
    return null;
  }
  async findManyByIdsForUser(
    attachmentIds: readonly string[],
    userId: string,
  ): Promise<Attachment[]> {
    this.calls += 1;
    return this.rows.filter((row) => row.ownerUserId === userId && attachmentIds.includes(row.id));
  }
  async attachToMessage(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async upsertExtraction(): Promise<void> {}
  async findExtraction(): Promise<null> {
    return null;
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

const dummyConfig = { FILE_RETENTION_HOURS: 48, STORAGE_MIN_FREE_MIB: 100 } as unknown as Config;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    ownerUserId: 'u-1',
    conversationId: 'c-1',
    messageId: 'm-1',
    messagePartId: null,
    origin: 'input',
    kind: 'image',
    displayName: 'photo.png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    sizeBytes: 2048,
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
    expiresAt: new Date('2026-10-20T00:00:00Z'),
    createdAt: new Date('2026-10-18T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function service(repo: FakeAttachmentRepo): AttachmentService {
  return new AttachmentService(
    dummyConfig,
    {} as StorageProviderPort,
    repo,
    {} as ConversationRepository,
    { now: () => new Date('2026-10-19T00:00:00Z') },
    { uuidv7: () => 'id' },
  );
}

describe('AttachmentService.listFiles', () => {
  it('projects a stored attachment into the contract file summary', async () => {
    const repo = new FakeAttachmentRepo();
    repo.rows.push(makeAttachment());

    const [file] = await service(repo).listFiles(['att-1'], 'u-1');

    expect(file).toEqual({
      id: 'att-1',
      name: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 200,
      height: 100,
      status: 'available',
    });
  });

  it.each<[AttachmentStatus, string]>([
    ['ready', 'available'],
    ['processing', 'processing'],
    ['uploading', 'processing'],
    ['validating', 'processing'],
    ['expired', 'expired'],
    ['deleted', 'expired'],
    ['missing', 'missing'],
    ['failed', 'missing'],
    ['rejected', 'missing'],
  ])('maps a %s attachment to file status %s', async (status, expected) => {
    const repo = new FakeAttachmentRepo();
    repo.rows.push(makeAttachment({ status }));

    const [file] = await service(repo).listFiles(['att-1'], 'u-1');
    expect(file?.status).toBe(expected);
  });

  it('omits attachments owned by another user', async () => {
    const repo = new FakeAttachmentRepo();
    repo.rows.push(makeAttachment({ id: 'att-other', ownerUserId: 'u-2' }));

    expect(await service(repo).listFiles(['att-other'], 'u-1')).toEqual([]);
  });

  it('skips the query when there is nothing to hydrate', async () => {
    const repo = new FakeAttachmentRepo();
    expect(await service(repo).listFiles([], 'u-1')).toEqual([]);
    expect(repo.calls).toBe(0);
  });
});

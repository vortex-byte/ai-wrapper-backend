import { describe, expect, it, vi } from 'vitest';

vi.mock('@/observability/logger.ts', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import {
  createAttachmentsExpiryHandler,
  createAttachmentsOrphanHandler,
} from '@/attachments/application/expiry-handler.ts';
import type { Attachment } from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    ownerUserId: 'u-1',
    conversationId: 'c-1',
    messageId: null,
    messagePartId: null,
    origin: 'generated',
    kind: 'image',
    displayName: 'chart.png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageProvider: 'local',
    storageBucket: null,
    storageKey: 'files/generated/2026/10/att-1',
    status: 'ready',
    errorCode: null,
    width: 100,
    height: 100,
    pageCount: null,
    metadata: { providerFileId: 'file-abc', providerKey: 'openai-main' },
    expiresAt: NOW,
    createdAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function repoWith(rows: readonly Attachment[]): AttachmentRepository & { marked: string[] } {
  const marked: string[] = [];
  const repo = {
    marked,
    insert: async () => {},
    findByIdAndUser: async () => null,
    findManyByIdsForUser: async () => [],
    attachToMessage: async () => {},
    updateStatus: async () => {},
    upsertExtraction: async () => {},
    findExtraction: async () => null,
    findDueForExpiry: async () => [...rows],
    findOrphans: async () => [...rows],
    listStorageKeys: async () => ({ keys: [], nextCursor: null }),
    markDeleted: async (ids: readonly string[]) => {
      marked.push(...ids);
    },
  } satisfies AttachmentRepository & { marked: string[] };
  return repo;
}

describe('attachments expiry handler', () => {
  it('deletes the local blob and the provider copy for an expired artifact', async () => {
    const repo = repoWith([attachment()]);
    const deletedKeys: string[] = [];
    const cleaned: Array<{ providerFileId: string; providerKey: string | null }> = [];

    const handler = createAttachmentsExpiryHandler({
      attachments: repo,
      storage: {
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      } as never,
      providerFiles: {
        deleteFile: async (file) => {
          cleaned.push(file);
          return true;
        },
      },
      clock: { now: () => NOW },
    });

    await expect(handler()).resolves.toEqual({ expiredCount: 1 });
    expect(repo.marked).toEqual(['att-1']);
    expect(deletedKeys).toEqual(['files/generated/2026/10/att-1']);
    expect(cleaned).toEqual([{ providerFileId: 'file-abc', providerKey: 'openai-main' }]);
  });

  it('skips provider cleanup for uploads with no provider copy', async () => {
    const repo = repoWith([attachment({ metadata: {}, origin: 'input' })]);
    const cleaned: string[] = [];

    const handler = createAttachmentsExpiryHandler({
      attachments: repo,
      storage: { delete: async () => {} } as never,
      providerFiles: {
        deleteFile: async (file) => {
          cleaned.push(file.providerFileId);
          return true;
        },
      },
      clock: { now: () => NOW },
    });

    await handler();
    expect(cleaned).toEqual([]);
  });

  it('still expires the attachment when the provider delete throws', async () => {
    const repo = repoWith([attachment()]);

    const handler = createAttachmentsExpiryHandler({
      attachments: repo,
      storage: { delete: async () => {} } as never,
      providerFiles: {
        deleteFile: async () => {
          throw new Error('provider down');
        },
      },
      clock: { now: () => NOW },
    });

    await expect(handler()).resolves.toEqual({ expiredCount: 1 });
    expect(repo.marked).toEqual(['att-1']);
  });
});

describe('attachments orphan handler', () => {
  it('also clears the provider copy of an orphaned artifact', async () => {
    const repo = repoWith([attachment()]);
    const cleaned: string[] = [];

    const handler = createAttachmentsOrphanHandler({
      attachments: repo,
      storage: { delete: async () => {} } as never,
      providerFiles: {
        deleteFile: async (file) => {
          cleaned.push(file.providerFileId);
          return true;
        },
      },
      clock: { now: () => NOW },
    });

    await expect(handler()).resolves.toEqual({ purgedCount: 1 });
    expect(cleaned).toEqual(['file-abc']);
  });
});

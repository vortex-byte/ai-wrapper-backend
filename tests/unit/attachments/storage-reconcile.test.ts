import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/observability/logger.ts', () => ({ getLogger: () => logger }));

import { createStorageReconcileHandler } from '@/attachments/application/storage-reconcile-handler.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { Attachment, FileExtraction } from '@/attachments/domain/attachment.ts';
import { LocalStorageProvider } from '@/storage/infrastructure/local-storage-provider.ts';
import type {
  GetStreamResult,
  PutStreamResult,
  StorageProviderPort,
} from '@/storage/ports/storage-provider.ts';

/** In-memory storage that mirrors the port: `listKeys` returns a prefix-filtered, `/`-separated set. */
class FakeStorage implements StorageProviderPort {
  readonly kind = 'fake';
  keys: string[] = [];
  readonly deleted: string[] = [];

  async putStream(): Promise<PutStreamResult> {
    throw new Error('not used');
  }

  async getStream(): Promise<GetStreamResult> {
    throw new Error('not used');
  }

  async exists(key: string): Promise<boolean> {
    return this.keys.includes(key);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.keys = this.keys.filter((existing) => existing !== key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return this.keys.filter((key) => key.startsWith(prefix));
  }
}

/** Fake repo honouring keyset semantics (`storage_key > cursor ORDER BY storage_key LIMIT n`). */
class FakeAttachmentRepo implements AttachmentRepository {
  readonly listCalls: Array<{ cursor: string | null; limit: number }> = [];

  constructor(private readonly dbKeys: readonly string[] = []) {}

  async insert(): Promise<void> {}
  async findByIdAndUser(): Promise<Attachment | null> {
    return null;
  }
  async attachToMessage(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async upsertExtraction(): Promise<void> {}
  async findExtraction(): Promise<FileExtraction | null> {
    return null;
  }
  async findDueForExpiry(): Promise<Attachment[]> {
    return [];
  }
  async findOrphans(): Promise<Attachment[]> {
    return [];
  }
  async markDeleted(): Promise<void> {}

  async listStorageKeys(
    cursor: string | null,
    limit: number,
  ): Promise<{ keys: string[]; nextCursor: string | null }> {
    this.listCalls.push({ cursor, limit });
    const sorted = [...this.dbKeys].sort();
    const start = cursor === null ? 0 : sorted.findIndex((key) => key > cursor);
    const keys = start === -1 ? [] : sorted.slice(start, start + limit);
    const last = keys[keys.length - 1];
    const nextCursor = keys.length === limit && last !== undefined ? last : null;
    return { keys, nextCursor };
  }
}

const clock = { now: () => new Date('2026-10-15T00:00:00Z') };

function handler(storage: FakeStorage, attachments: FakeAttachmentRepo) {
  return createStorageReconcileHandler({ storage, attachments, clock });
}

describe('storage.reconcile handler', () => {
  it('deletes and counts a blob present on disk but absent from the database', async () => {
    const storage = new FakeStorage();
    storage.keys = ['files/2026/10/kept', 'files/2026/10/orphan'];
    const attachments = new FakeAttachmentRepo(['files/2026/10/kept']);

    const result = await handler(storage, attachments)();

    expect(result).toEqual({ orphanedBlobsDeleted: 1, missingBlobs: 0, scannedKeys: 2 });
    expect(storage.deleted).toEqual(['files/2026/10/orphan']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports a DB key with no blob as missing, without deleting anything', async () => {
    const storage = new FakeStorage();
    storage.keys = ['files/2026/10/present'];
    const attachments = new FakeAttachmentRepo(['files/2026/10/present', 'files/2026/10/ghost']);

    const result = await handler(storage, attachments)();

    expect(result).toEqual({ orphanedBlobsDeleted: 0, missingBlobs: 1, scannedKeys: 1 });
    expect(storage.deleted).toEqual([]);
    expect(storage.keys).toEqual(['files/2026/10/present']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ missingBlobs: 1 });
  });

  it('reports zeros when disk and database agree', async () => {
    const storage = new FakeStorage();
    storage.keys = ['files/2026/10/a', 'files/2026/10/b'];
    const attachments = new FakeAttachmentRepo(['files/2026/10/a', 'files/2026/10/b']);

    const result = await handler(storage, attachments)();

    expect(result).toEqual({ orphanedBlobsDeleted: 0, missingBlobs: 0, scannedKeys: 2 });
    expect(storage.deleted).toEqual([]);
  });

  it('reports zeros when both sides are empty', async () => {
    const result = await handler(new FakeStorage(), new FakeAttachmentRepo())();

    expect(result).toEqual({ orphanedBlobsDeleted: 0, missingBlobs: 0, scannedKeys: 0 });
  });

  it('is idempotent: a second run finds nothing to delete', async () => {
    const storage = new FakeStorage();
    storage.keys = ['files/2026/10/orphan'];
    const attachments = new FakeAttachmentRepo();
    const run = handler(storage, attachments);

    const first = await run();
    const second = await run();

    expect(first.orphanedBlobsDeleted).toBe(1);
    expect(second.orphanedBlobsDeleted).toBe(0);
    expect(storage.deleted).toEqual(['files/2026/10/orphan']);
  });

  it('paginates the database scan across more than one batch of keys', async () => {
    const present = Array.from(
      { length: 1200 },
      (_, i) => `files/2026/10/k${String(i).padStart(4, '0')}`,
    );
    const lateMissing = 'files/2026/10/z-late-missing';
    const earlyOrphan = 'files/2026/10/a-early-orphan';

    const storage = new FakeStorage();
    storage.keys = [earlyOrphan, ...present];
    const attachments = new FakeAttachmentRepo([...present, lateMissing]);

    const result = await handler(storage, attachments)();

    // Every DB page was walked: the key that only appears after the first 500 rows is still found.
    expect(attachments.listCalls.length).toBeGreaterThan(1);
    expect(attachments.listCalls.every((call) => call.limit === 500)).toBe(true);
    expect(attachments.listCalls[0]?.cursor).toBeNull();
    expect(attachments.listCalls.at(-1)?.cursor).not.toBeNull();

    expect(result).toEqual({
      orphanedBlobsDeleted: 1,
      missingBlobs: 1,
      scannedKeys: 1201,
    });
    expect(storage.deleted).toEqual([earlyOrphan]);
  });

  it('scans every stored key, not just the first page', async () => {
    const present = Array.from(
      { length: 600 },
      (_, i) => `files/2026/10/k${String(i).padStart(4, '0')}`,
    );
    const storage = new FakeStorage();
    storage.keys = [...present, 'files/2026/10/z-orphan'];
    const attachments = new FakeAttachmentRepo(present);

    const result = await handler(storage, attachments)();

    expect(result.scannedKeys).toBe(601);
    expect(result.missingBlobs).toBe(0);
    expect(storage.deleted).toEqual(['files/2026/10/z-orphan']);
  });
});

describe('LocalStorageProvider.listKeys', () => {
  const roots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-reconcile-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('walks nested directories and returns key-style paths with `/` separators', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'files', '2026', '10'), { recursive: true });
    await fs.writeFile(path.join(root, 'files', '2026', '10', 'blob-a'), 'a');
    await fs.writeFile(path.join(root, 'files', '2026', '10', 'blob-b'), 'b');
    await fs.writeFile(path.join(root, 'other.txt'), 'x');

    const keys = await new LocalStorageProvider(root).listKeys('files/');

    expect(keys).toEqual(['files/2026/10/blob-a', 'files/2026/10/blob-b']);
  });

  it('returns [] when the root does not exist', async () => {
    const provider = new LocalStorageProvider(path.join(os.tmpdir(), 'storage-reconcile-missing'));
    await expect(provider.listKeys('files/')).resolves.toEqual([]);
  });

  it('refuses a prefix that escapes the root', async () => {
    const root = await makeRoot();
    await expect(new LocalStorageProvider(root).listKeys('../etc')).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
  });
});

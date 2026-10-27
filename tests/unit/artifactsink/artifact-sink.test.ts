import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/observability/logger.ts', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { ArtifactSink } from '@/artifactsink/artifact-sink.ts';
import type { Attachment, FileExtraction } from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** In-memory storage: measures + hashes the stored bytes exactly like the local provider. */
class FakeStorage implements StorageProviderPort {
  readonly kind = 'fake';
  readonly blobs = new Map<string, Uint8Array>();
  deleted: string[] = [];
  failPut = false;

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { readonly contentType: string; readonly maxBytes: number },
  ): Promise<{ key: string; sizeBytes: number; sha256: string }> {
    if (this.failPut) throw new Error('disk full');
    let bytes: Uint8Array;
    if (body instanceof Uint8Array) {
      bytes = body;
    } else {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of body) {
        chunks.push(chunk);
        size += chunk.byteLength;
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    if (bytes.byteLength > options.maxBytes) throw new Error('too large');
    this.blobs.set(key, bytes);
    return { key, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
  }

  async getStream(): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number }> {
    throw new Error('not used');
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.blobs.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.blobs.keys()].filter((key) => key.startsWith(prefix));
  }
}

class FakeAttachmentRepo implements AttachmentRepository {
  readonly inserted: Attachment[] = [];
  readonly deleted: string[] = [];
  async insert(attachment: Attachment, extraction?: FileExtraction | null): Promise<void> {
    void extraction;
    this.inserted.push(attachment);
  }
  async findByIdAndUser(): Promise<Attachment | null> {
    return null;
  }
  async findManyByIdsForUser(): Promise<Attachment[]> {
    return [];
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
  async listStorageKeys(): Promise<{ keys: string[]; nextCursor: string | null }> {
    return { keys: [], nextCursor: null };
  }
  async markDeleted(attachmentIds: readonly string[]): Promise<void> {
    this.deleted.push(...attachmentIds);
  }
}

class FakeConversationRepo {
  readonly attached: Array<{ partId: string; fileId: string }> = [];
  readonly failedParts: string[] = [];
  failAttach = false;
  async attachPartFile(partId: string, fileId: string): Promise<void> {
    if (this.failAttach) throw new Error('link failed');
    this.attached.push({ partId, fileId });
  }
  async updatePart(partId: string, updates: { readonly status: 'failed' }): Promise<void> {
    if (updates.status === 'failed') this.failedParts.push(partId);
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sinkWith(deps: {
  storage: FakeStorage;
  attachments: FakeAttachmentRepo;
  conversations: FakeConversationRepo;
}) {
  return new ArtifactSink({
    storage: deps.storage,
    attachments: deps.attachments,
    conversations: deps.conversations,
    clock: { now: () => new Date('2026-06-01T00:00:00Z') },
    idGen: { uuidv7: () => 'att-uuid' },
    retentionDays: 30,
    maxBytes: 10 * 1024 * 1024,
    backoffMs: [0, 0, 0],
  });
}

const input = {
  partId: 'part-1',
  userId: 'u-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  providerFileId: 'file_abc',
  filename: 'report.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

describe('ArtifactSink', () => {
  it('persists then links: the attachment reflects the *stored* bytes, not the provider claim', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    const result = await sink.hydrate(input, async () => ({
      stream: new Blob([bytes('spreadsheet-bytes')]).stream(),
      // A deliberately wrong provider claim — the sink must ignore it.
      sizeBytes: 999999,
      mimeType: input.mimeType,
      filename: 'report.xlsx',
    }));

    expect(result).toEqual({ attachmentId: 'att-uuid' });
    const row = attachments.inserted[0];
    expect(row?.origin).toBe('generated');
    expect(row?.sizeBytes).toBe(bytes('spreadsheet-bytes').byteLength);
    expect(row?.sha256).toBe(sha256(bytes('spreadsheet-bytes')));
    expect(row?.status).toBe('ready');
    expect(row?.metadata['providerFileId']).toBe('file_abc');
    expect(conversations.attached).toEqual([{ partId: 'part-1', fileId: 'att-uuid' }]);
    expect(conversations.failedParts).toEqual([]);
    // Retention horizon is applied from the clock.
    expect(row?.expiresAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('retries the download and returns null, marking the part failed, when all attempts fail', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    const fetchArtifact = vi.fn(async () => {
      throw new Error('429 rate limited');
    });

    const result = await sink.hydrate(input, fetchArtifact);

    expect(result).toBeNull();
    expect(fetchArtifact).toHaveBeenCalledTimes(3);
    expect(conversations.failedParts).toEqual(['part-1']);
    expect(attachments.inserted).toHaveLength(0);
  }, 20_000);

  it('removes a partially written blob when persistence fails and marks the part failed', async () => {
    const storage = new FakeStorage();
    storage.failPut = true;
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    const result = await sink.hydrate(input, async () => ({
      stream: new Blob([bytes('x')]).stream(),
    }));

    expect(result).toBeNull();
    expect(conversations.failedParts).toEqual(['part-1']);
    expect(storage.deleted.length).toBe(1);
  });

  it('classifies image and document artifacts for the right content disposition', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    await sink.hydrate(
      { ...input, providerFileId: 'file_img', filename: 'chart.png', mimeType: 'image/png' },
      async () => ({ stream: new Blob([bytes('png')]).stream(), mimeType: 'image/png' }),
    );
    await sink.hydrate(
      {
        ...input,
        providerFileId: 'file_pdf',
        filename: 'summary.pdf',
        mimeType: 'application/pdf',
      },
      async () => ({ stream: new Blob([bytes('pdf')]).stream(), mimeType: 'application/pdf' }),
    );

    expect(attachments.inserted[0]?.kind).toBe('image');
    expect(attachments.inserted[1]?.kind).toBe('document');
  });

  it('prefers the filename-derived type over a generic octet-stream download', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    // Container downloads commonly report `application/octet-stream`; the real type is known
    // from the sanitized filename and must not be lost.
    await sink.hydrate(input, async () => ({
      stream: new Blob([bytes('xlsx')]).stream(),
      mimeType: 'application/octet-stream',
    }));

    const row = attachments.inserted[0];
    expect(row?.detectedMime).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(row?.kind).toBe('document');
  });

  it('stores inline provider bytes without ever calling the downloader', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });
    const fetchArtifact = vi.fn(async () => {
      throw new Error('must not download');
    });

    // OpenAI's hosted image tool returns the image inline, not as a file id.
    const result = await sink.hydrate(
      {
        ...input,
        providerFileId: 'image:ig_1',
        filename: 'image-1.png',
        mimeType: 'image/png',
        bytes: bytes('png-bytes'),
      },
      fetchArtifact,
    );

    expect(result).toEqual({ attachmentId: 'att-uuid' });
    expect(fetchArtifact).not.toHaveBeenCalled();
    const row = attachments.inserted[0];
    expect(row?.kind).toBe('image');
    expect(row?.detectedMime).toBe('image/png');
    expect(row?.sizeBytes).toBe(bytes('png-bytes').byteLength);
    expect(row?.sha256).toBe(sha256(bytes('png-bytes')));
    // The handle stays small: only the stored bytes are the payload.
    expect(row?.metadata['providerFileId']).toBe('image:ig_1');
    expect(conversations.attached).toEqual([{ partId: 'part-1', fileId: 'att-uuid' }]);
  });

  it('fails the part when inline bytes are empty instead of storing a zero-byte blob', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });

    const result = await sink.hydrate(
      { ...input, providerFileId: 'image:ig_1', filename: 'image-1.png', bytes: new Uint8Array(0) },
      async () => {
        throw new Error('must not download');
      },
    );

    expect(result).toBeNull();
    expect(conversations.failedParts).toEqual(['part-1']);
    expect(attachments.inserted).toHaveLength(0);
  });

  it('does not retry a non-retryable provider error', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    const sink = sinkWith({ storage, attachments, conversations });
    const fetchArtifact = vi.fn(async () => {
      throw Object.assign(new Error('not found'), { category: 'not_found', retryable: false });
    });

    const result = await sink.hydrate(input, fetchArtifact);

    expect(result).toBeNull();
    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    expect(conversations.failedParts).toEqual(['part-1']);
  });

  it('compensates a failed part link by deleting the stored blob and the attachment row', async () => {
    const storage = new FakeStorage();
    const attachments = new FakeAttachmentRepo();
    const conversations = new FakeConversationRepo();
    conversations.failAttach = true;
    const sink = sinkWith({ storage, attachments, conversations });

    const result = await sink.hydrate(input, async () => ({
      stream: new Blob([bytes('xlsx')]).stream(),
    }));

    expect(result).toBeNull();
    expect(attachments.deleted).toEqual(['att-uuid']);
    expect(storage.deleted).toHaveLength(1);
    expect(conversations.failedParts).toEqual(['part-1']);
  });
});

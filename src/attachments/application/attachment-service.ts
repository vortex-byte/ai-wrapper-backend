import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import type { StorageProviderPort, StorageHealthProbe } from '@/storage/ports/storage-provider.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import {
  FILE_LIMITS,
  detectUploadKind,
  sanitizeDisplayName,
  validateUpload,
  type Attachment,
  type AttachmentFileRef,
  type AttachmentStatus,
  type FileExtraction,
  type ResolvedAttachmentPart,
  type SupportedUploadKind,
} from '../domain/attachment.ts';
import type { AttachmentRepository } from '../ports/attachment-repository.ts';
import { extractTextForKind } from './text-extraction.ts';

export interface UploadInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly fileName: string;
  readonly declaredMime: string | null;
  readonly bytes: Uint8Array;
}

export interface UploadResult {
  readonly attachment: Attachment;
  readonly extraction: FileExtraction | null;
}

export interface AttachmentView {
  readonly id: string;
  readonly conversationId: string;
  readonly origin: Attachment['origin'];
  readonly kind: Attachment['kind'];
  readonly displayName: string;
  readonly detectedMime: string;
  readonly sizeBytes: number;
  readonly status: AttachmentStatus;
  readonly errorCode: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly pageCount: number | null;
  readonly extraction: {
    readonly status: FileExtraction['status'];
    readonly charCount: number | null;
    readonly truncated: boolean;
    readonly errorCode: string | null;
  } | null;
  readonly createdAt: Date;
}

function toView(attachment: Attachment, extraction: FileExtraction | null): AttachmentView {
  return {
    id: attachment.id,
    conversationId: attachment.conversationId,
    origin: attachment.origin,
    kind: attachment.kind,
    displayName: attachment.displayName,
    detectedMime: attachment.detectedMime,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    errorCode: attachment.errorCode,
    width: attachment.width,
    height: attachment.height,
    pageCount: attachment.pageCount,
    extraction:
      extraction !== null
        ? {
            status: extraction.status,
            charCount: extraction.charCount,
            truncated: extraction.truncated,
            errorCode: extraction.errorCode,
          }
        : null,
    createdAt: attachment.createdAt,
  };
}

/** Opaque key layout: `files/<yyyy-mm>/<uuid>`, never a filesystem path. */
function storageKeyFor(clock: Clock, idGen: IdGenerator): string {
  const now = clock.now();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `files/${month}/${idGen.uuidv7()}`;
}

export class AttachmentService {
  constructor(
    private readonly config: Config,
    private readonly storage: StorageProviderPort,
    private readonly attachments: AttachmentRepository,
    private readonly conversations: ConversationRepository,
    private readonly clock: Clock,
    private readonly idGen: IdGenerator,
  ) {}

  /**
   * Ends with inline extraction, which normally finishes inside the request.
   */
  async upload(input: UploadInput): Promise<UploadResult> {
    if (input.bytes.byteLength === 0) {
      throw new AppError('unsupported_file_type', 'The file is empty.');
    }
    if (input.bytes.byteLength > FILE_LIMITS.maxBytes) {
      throw new AppError('file_too_large');
    }

    // Refuse before writing when the disk is already too full to take the file.
    if (isHealthProbe(this.storage)) {
      const health = await this.storage.health();
      if (health.freeBytes < this.config.STORAGE_MIN_FREE_MIB * 1024 * 1024) {
        throw new AppError('storage_unavailable', 'File storage is low on space.');
      }
    }

    const conversation = await this.conversations.findByIdForUser(
      input.conversationId,
      input.userId,
    );
    if (conversation === null) {
      throw new AppError('not_found');
    }

    const kind = detectUploadKind(input.bytes);
    if (kind === null) {
      throw new AppError('unsupported_file_type');
    }

    const validation = validateUpload({
      kind,
      bytes: input.bytes,
      declaredMime: input.declaredMime,
    });

    const id = this.idGen.uuidv7();
    const key = storageKeyFor(this.clock, this.idGen);
    const stored = await this.storage.putStream(key, input.bytes, {
      contentType: validation.detectedMime,
      maxBytes: FILE_LIMITS.maxBytes,
    });

    // Fail the upload if the streamed bytes disagree with the request size (truncated body).
    if (stored.sizeBytes !== input.bytes.byteLength) {
      await this.storage.delete(key);
      throw new AppError('invalid_request', 'Upload size mismatch.');
    }

    const attachment: Attachment = {
      id,
      ownerUserId: input.userId,
      conversationId: input.conversationId,
      messageId: null,
      messagePartId: null,
      origin: 'input',
      kind: validation.kind,
      displayName: sanitizeDisplayName(input.fileName),
      declaredMime: input.declaredMime,
      detectedMime: validation.detectedMime,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageProvider: this.storage.kind,
      storageBucket: null,
      storageKey: key,
      status: 'ready',
      errorCode: null,
      width: validation.width,
      height: validation.height,
      pageCount: validation.pageCount,
      metadata: {},
      expiresAt: new Date(
        this.clock.now().getTime() + this.config.FILE_RETENTION_HOURS * 3_600_000,
      ),
      createdAt: this.clock.now(),
      deletedAt: null,
    };

    const extraction = await this.extractFor(attachment, kind, input.bytes);
    await this.attachments.insert(attachment, extraction);

    return { attachment, extraction };
  }

  /** Metadata view for the owner; another user's id is `404`. */
  async getForUser(attachmentId: string, userId: string): Promise<AttachmentView> {
    const attachment = await this.attachments.findByIdAndUser(attachmentId, userId);
    if (attachment === null || attachment.deletedAt !== null) {
      throw new AppError('not_found');
    }
    const extraction = await this.attachments.findExtraction(attachment.id);
    return toView(attachment, extraction);
  }

  /**
   * Turns uploads into parts for the context builder: images stay images, everything else becomes
   * a document part carrying the extracted text, so history stays readable without the binary.
   *
   * Ownership-scoped: an id that isn't the caller's is `404`. Bytes are read lazily through the
   * storage port, so a part costs nothing until an adapter asks for them.
   *
   * `conversationId` pins the file to the conversation being written, so a guessed id cannot leak
   * content across threads. `requireUnbound` rejects a file already linked to a message: the send
   * path sets it, the retry path does not, because its files are bound to the message it retries.
   */
  async resolveParts(
    fileIds: readonly string[],
    userId: string,
    options: {
      readonly conversationId?: string | undefined;
      readonly requireUnbound?: boolean | undefined;
    } = {},
  ): Promise<{ parts: ResolvedAttachmentPart[]; attachments: Attachment[] }> {
    const parts: ResolvedAttachmentPart[] = [];
    const resolved: Attachment[] = [];

    for (const fileId of fileIds) {
      const attachment = await this.attachments.findByIdAndUser(fileId, userId);
      if (attachment === null || attachment.deletedAt !== null) {
        throw new AppError('not_found', 'Attachment not found.');
      }
      if (
        options.conversationId !== undefined &&
        attachment.conversationId !== options.conversationId
      ) {
        throw new AppError('not_found', 'Attachment not found.');
      }
      if (options.requireUnbound === true && attachment.messageId !== null) {
        throw new AppError('conflict', 'This attachment is already part of another message.');
      }
      if (attachment.status !== 'ready') {
        throw new AppError('file_not_ready', 'The file is still being processed.');
      }

      const extraction = await this.attachments.findExtraction(attachment.id);
      const file = this.resolvedFile(attachment);

      if (attachment.kind === 'image') {
        parts.push({ type: 'image', file });
      } else {
        parts.push({
          type: 'document',
          file,
          ...(extraction?.text !== null && extraction?.text !== undefined
            ? { extractedText: extraction.text }
            : {}),
          // Native document blocks preserve layout; the extracted text is the fallback context.
          preferNative: true,
        });
      }
      resolved.push(attachment);
    }

    return { parts, attachments: resolved };
  }

  private resolvedFile(attachment: Attachment): AttachmentFileRef {
    return {
      fileId: attachment.id,
      mimeType: attachment.detectedMime,
      name: attachment.displayName,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.width !== null ? { width: attachment.width } : {}),
      ...(attachment.height !== null ? { height: attachment.height } : {}),
      ...(attachment.pageCount !== null ? { pageCount: attachment.pageCount } : {}),
      read: async () => this.readStoredBytes(attachment),
      stream: async () => (await this.storage.getStream(attachment.storageKey)).stream,
    };
  }

  /**
   * Content stream for the owner. Rejects tombstoned/expired rows with 404.
   * Byte ranges (RFC 7233): `{start, end?}` for prefix ranges, `{suffixLength}`
   * for the last-N form. The response always carries concrete start/end/total
   * so the HTTP layer can emit a correct `Content-Range`.
   */
  async getContent(
    attachmentId: string,
    userId: string,
    range?:
      | { readonly start: number; readonly end?: number }
      | { readonly suffixLength: number }
      | undefined,
  ): Promise<{
    readonly attachment: Attachment;
    readonly stream: ReadableStream<Uint8Array>;
    readonly start: number;
    readonly end: number;
    readonly totalBytes: number;
    readonly partial: boolean;
  }> {
    const attachment = await this.attachments.findByIdAndUser(attachmentId, userId);
    if (attachment === null || attachment.deletedAt !== null) {
      throw new AppError('not_found');
    }
    if (
      attachment.status === 'expired' ||
      attachment.status === 'deleted' ||
      attachment.status === 'rejected'
    ) {
      throw new AppError('not_found');
    }

    const total = attachment.sizeBytes;
    // An empty blob cannot satisfy any byte range; serve it whole (an empty 200) rather than
    // emitting a malformed `Content-Range: bytes 0--1/0`.
    if (range === undefined || total === 0) {
      const result = await this.storage.getStream(attachment.storageKey);
      return {
        attachment,
        stream: result.stream,
        start: 0,
        end: total - 1,
        totalBytes: total,
        partial: false,
      };
    }

    let storageRange: { start: number; end?: number };
    if ('suffixLength' in range) {
      const start = Math.max(0, total - range.suffixLength);
      storageRange = { start };
    } else {
      storageRange = { start: range.start, ...(range.end !== undefined ? { end: range.end } : {}) };
    }

    const result = await this.storage.getStream(attachment.storageKey, storageRange);
    const start = 'suffixLength' in range ? Math.max(0, total - range.suffixLength) : range.start;
    const end = start + result.sizeBytes - 1;
    return { attachment, stream: result.stream, start, end, totalBytes: total, partial: true };
  }

  async extractFor(
    attachment: Attachment,
    kind: SupportedUploadKind,
    bytes?: Uint8Array,
  ): Promise<FileExtraction | null> {
    if (kind === 'png' || kind === 'jpeg' || kind === 'webp' || kind === 'gif') {
      return null; // images are not text-extracted
    }
    const payload = bytes ?? (await this.readStoredBytes(attachment));
    const result = await extractTextForKind({ kind, bytes: payload });
    return {
      fileId: attachment.id,
      status: result.status,
      extractor: result.extractor,
      text: result.text,
      charCount: result.text !== null ? result.text.length : null,
      tokenEstimate: result.text !== null ? Math.ceil(result.text.length / 4) : null,
      truncated: result.truncated,
      pageCount: result.pageCount,
      errorCode: result.errorCode ?? null,
    };
  }

  /**
   * Re-reads the stored bytes for extraction. The upload path could inline them,
   * but routing through the port keeps extraction usable from retry jobs too.
   */
  private async readStoredBytes(attachment: Attachment): Promise<Uint8Array> {
    const result = await this.storage.getStream(attachment.storageKey);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of result.stream) {
      size += chunk.byteLength;
      if (size > FILE_LIMITS.maxBytes) {
        throw new AppError('file_too_large');
      }
      chunks.push(chunk);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
}

function isHealthProbe(
  storage: StorageProviderPort,
): storage is StorageProviderPort & StorageHealthProbe {
  return 'health' in storage && typeof (storage as StorageHealthProbe).health === 'function';
}

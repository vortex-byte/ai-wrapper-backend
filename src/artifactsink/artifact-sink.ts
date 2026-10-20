import type { Clock, IdGenerator } from '@/clock/index.ts';
import { getLogger } from '@/observability/logger.ts';
import type { StorageProviderPort } from '@/storage/ports/storage-provider.ts';
import {
  sanitizeDisplayName,
  type Attachment,
  type AttachmentKind,
} from '@/attachments/domain/attachment.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { ProviderArtifact } from '@/providers/ports/provider-adapter.ts';

/**
 * Hydrates provider-generated binaries into local storage.
 *
 * Persist before expose: a file becomes visible (via `part.completed` with a `downloadUrl`) only
 * once its bytes and the `attachments` row exist, and the stored bytes are re-measured rather than
 * trusted. A failed download marks the part `failed` and returns `null`; the generation itself
 * completes normally.
 */

/** Anthropic cloud containers live 30 days, so generated files default to the same horizon. */
export const GENERATED_FILE_RETENTION_DAYS = 30;
/** Hard cap on one hydrated artifact — a runaway container cannot fill the VPS disk. */
export const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;
/** Files-API download timeout; a hung provider request must not wedge finalization. */
export const ARTIFACT_FETCH_TIMEOUT_MS = 60_000;

export interface ArtifactHydrationInput {
  readonly partId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly providerFileId: string;
  readonly filename: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes?: number | undefined;
  /**
   * Bytes the provider already handed back in the response (OpenAI's hosted image tool returns
   * base64). When present there is nothing to download and no retry loop.
   */
  readonly bytes?: Uint8Array | undefined;
}

/** Fetches the provider-side bytes; supplied per generation (it closes over adapter + secrets). */
export type ArtifactFetcher = (providerFileId: string) => Promise<ProviderArtifact>;

/**
 * The slice of the conversations module the sink needs: link the stored bytes to the awaiting
 * part, or mark it failed. Declared narrowly so the sink depends on a capability, not a module.
 */
export interface ArtifactPartLinker {
  attachPartFile(partId: string, fileId: string): Promise<void>;
  updatePart(partId: string, updates: { readonly status: 'failed' }): Promise<void>;
}

export interface ArtifactSinkDeps {
  readonly storage: StorageProviderPort;
  readonly attachments: AttachmentRepository;
  readonly conversations: ArtifactPartLinker;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  /** Retention for generated files, in days (Anthropic containers live 30 days). */
  readonly retentionDays: number;
  /** Hard cap on a single hydrated artifact; guards against a runaway provider response. */
  readonly maxBytes: number;
  /** Retry backoff between download attempts; overridable for tests. */
  readonly backoffMs?: readonly number[] | undefined;
}

const DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;

/** Wraps already-in-hand bytes as the stream the storage port expects. */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Provider errors carry the retry verdict; anything else is treated as transient. */
function isNonRetryableProviderError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (!('retryable' in err) || !('category' in err)) return false;
  return err.retryable === false;
}

/** Only the stable category is safe to log; provider messages can carry response bodies. */
function errorCategory(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('category' in err)) return undefined;
  return typeof err.category === 'string' ? err.category : undefined;
}

function kindForMime(mimeType: string | undefined, filename: string): AttachmentKind {
  const mime = mimeType ?? '';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(filename)) return 'image';
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|rtf|odt|ods|odp|epub)$/i.test(filename)
  ) {
    return 'document';
  }
  return 'other';
}

function guessMime(mimeType: string | undefined, filename: string): string {
  // Container downloads often come back as `application/octet-stream`; prefer the type we
  // derived from the (sanitized) name over that placeholder, so a stored docx/xlsx is served
  // with its real Content-Type.
  if (mimeType !== undefined && mimeType !== '' && mimeType !== 'application/octet-stream') {
    return mimeType;
  }
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'csv':
      return 'text/csv';
    case 'txt':
      return 'text/plain';
    case 'md':
      return 'text/markdown';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

export class ArtifactSink {
  constructor(private readonly deps: ArtifactSinkDeps) {}

  /**
   * Downloads → stores → records → links. Returns the new attachment id, or `null` when the
   * artifact could not be hydrated (the calling part is then marked failed).
   */
  async hydrate(
    input: ArtifactHydrationInput,
    fetchArtifact: ArtifactFetcher,
  ): Promise<{ attachmentId: string } | null> {
    const { storage, attachments, conversations, clock, idGen } = this.deps;

    let artifact: ProviderArtifact | null = null;
    if (input.bytes !== undefined) {
      if (input.bytes.byteLength === 0) {
        await this.markPartFailed(input.partId);
        return null;
      }
      artifact = {
        stream: byteStream(input.bytes),
        sizeBytes: input.bytes.byteLength,
      };
    }

    let lastError: unknown;
    const backoffMs = this.deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    for (let attempt = 0; artifact === null && attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        artifact = await fetchArtifact(input.providerFileId);
        break;
      } catch (err) {
        lastError = err;
        // A permanent failure (404, bad handle) must not cost two more attempts inside the
        // stream loop.
        if (isNonRetryableProviderError(err)) break;
        const backoff = backoffMs[attempt];
        if (backoff !== undefined && attempt < DOWNLOAD_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    if (artifact === null) {
      getLogger().warn(
        {
          providerFileId: input.providerFileId,
          component: 'artifactsink',
          category: errorCategory(lastError),
        },
        'artifact download failed after retries',
      );
      await this.markPartFailed(input.partId);
      return null;
    }

    const id = idGen.uuidv7();
    // Provider-supplied names are untrusted: single path segment, no traversal, no control
    // or bidi characters, capped length (the same rule as uploads).
    const displayName = sanitizeDisplayName(input.filename);
    const key = this.storageKeyFor(id);

    let stored: { sizeBytes: number; sha256: string };
    try {
      stored = await storage.putStream(key, artifact.stream, {
        contentType: guessMime(artifact.mimeType ?? input.mimeType, displayName),
        maxBytes: this.deps.maxBytes,
      });
    } catch (err) {
      await storage.delete(key).catch(() => {});
      getLogger().warn(
        { component: 'artifactsink', category: errorCategory(err) },
        'artifact storage write failed',
      );
      await this.markPartFailed(input.partId);
      return null;
    }

    const detectedMime = guessMime(artifact.mimeType ?? input.mimeType, displayName);
    const now = clock.now();
    const attachment: Attachment = {
      id,
      ownerUserId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      messagePartId: input.partId,
      origin: 'generated',
      kind: kindForMime(artifact.mimeType ?? input.mimeType, displayName),
      displayName,
      declaredMime: input.mimeType ?? null,
      detectedMime,
      // Always the *stored* bytes, never the provider's estimate.
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageProvider: storage.kind,
      storageBucket: null,
      storageKey: key,
      status: 'ready',
      errorCode: null,
      width: null,
      height: null,
      pageCount: null,
      metadata: { providerFileId: input.providerFileId, filename: displayName },
      expiresAt: new Date(now.getTime() + this.deps.retentionDays * 86_400_000),
      createdAt: now,
      deletedAt: null,
    };

    try {
      await attachments.insert(attachment, null);
      await conversations.attachPartFile(input.partId, id);
    } catch (err) {
      // Either the row or the link failed; drop both the blob and any row already written so
      // the part can never point at bytes that a `ready` attachment claims to own.
      await storage.delete(key).catch(() => {});
      await attachments.markDeleted([id]).catch(() => {});
      getLogger().error(
        { component: 'artifactsink', category: errorCategory(err) },
        'artifact row insert failed',
      );
      await this.markPartFailed(input.partId);
      return null;
    }

    return { attachmentId: id };
  }

  /** Best-effort: a part whose artifact never arrived is marked failed so the UI stops waiting. */
  private async markPartFailed(partId: string): Promise<void> {
    try {
      await this.deps.conversations.updatePart(partId, { status: 'failed' });
    } catch {
      // never let part bookkeeping fail the generation
    }
  }

  /** `files/generated/YYYY-MM/<uuid>` — the same opaque layout the upload path uses. */
  private storageKeyFor(id: string): string {
    const now = this.deps.clock.now();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `files/generated/${month}/${id}`;
  }
}

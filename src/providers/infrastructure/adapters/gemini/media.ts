import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { NormalizedPart, ResolvedFile } from '@/providers/domain/pal.ts';
import { INLINE_DATA_URL_PREFIX, MAX_INLINE_BYTES } from './config.ts';
import type { InlineArtifact } from './types.ts';

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(data: string): Uint8Array {
  return Buffer.from(data, 'base64');
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function parseInlineHandle(providerFileId: string): InlineArtifact | null {
  if (!providerFileId.startsWith(INLINE_DATA_URL_PREFIX)) return null;
  const match = /^data:([^;,]*);base64,(.*)$/.exec(providerFileId);
  if (match === null) return null;
  const mimeType = match[1] ?? '';
  const bytes = fromBase64(match[2] ?? '');
  return { bytes, ...(mimeType.length > 0 ? { mimeType } : {}) };
}

export function fileIdFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const last = withoutQuery
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop();
  return last !== undefined ? decodeURIComponent(last) : uri;
}

export function extensionFor(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'application/pdf':
      return '.pdf';
    default:
      return '.bin';
  }
}

export function mimeTypeFor(file: ResolvedFile): string {
  return file.mimeType !== undefined && file.mimeType.length > 0
    ? file.mimeType
    : 'application/octet-stream';
}

export async function readInlineBytes(file: ResolvedFile): Promise<Uint8Array> {
  if (file.sizeBytes > MAX_INLINE_BYTES) throw inlineTooLargeError();
  const bytes = await file.read();
  if (bytes.byteLength > MAX_INLINE_BYTES) throw inlineTooLargeError();
  return bytes;
}

function inlineTooLargeError(): ProviderError {
  return providerError(
    'unsupported_for_model',
    'The attached file is too large to send inline to this model.',
    { retryable: false },
  );
}

export async function mediaPart(part: NormalizedPart): Promise<unknown> {
  if (part.type === 'text') return { text: part.text };
  if (part.type === 'tool_call' || part.type === 'tool_result') {
    throw providerError(
      'unsupported_for_model',
      'This request uses client-side tools, which this provider does not accept.',
      { retryable: false },
    );
  }
  if (part.type === 'compaction') {
    throw providerError(
      'unsupported_for_model',
      'This model does not support provider-side compaction.',
      { retryable: false },
    );
  }

  if (
    part.type === 'document' &&
    !part.preferNative &&
    part.extractedText !== undefined &&
    part.extractedText.trim().length > 0
  ) {
    return { text: part.extractedText };
  }

  const bytes = await readInlineBytes(part.file);
  const mimeType = mimeTypeFor(part.file);
  return { inlineData: { mimeType, data: toBase64(bytes) } };
}

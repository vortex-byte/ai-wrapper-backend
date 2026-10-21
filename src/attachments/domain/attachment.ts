/** Attachment domain: limits, formats, content sniffing, and validation. */

export class AttachmentValidationError extends Error {
  readonly code: 'unsupported_file_type' | 'file_too_large';
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: 'unsupported_file_type' | 'file_too_large',
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
    this.status = options.status ?? (code === 'file_too_large' ? 413 : 415);
    this.retryable = options.retryable ?? false;
  }
}

export function isAttachmentValidationError(value: unknown): value is AttachmentValidationError {
  return value instanceof AttachmentValidationError;
}

export type AttachmentOrigin = 'input' | 'generated';
export type AttachmentKind = 'image' | 'document' | 'other';
export type AttachmentStatus =
  | 'uploading'
  | 'validating'
  | 'processing'
  | 'ready'
  | 'rejected'
  | 'failed'
  | 'missing'
  | 'expired'
  | 'deleted';

export interface Attachment {
  readonly id: string;
  readonly ownerUserId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly messagePartId: string | null;
  readonly origin: AttachmentOrigin;
  readonly kind: AttachmentKind;
  readonly displayName: string;
  readonly declaredMime: string | null;
  readonly detectedMime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageProvider: string;
  readonly storageBucket: string | null;
  readonly storageKey: string;
  readonly status: AttachmentStatus;
  readonly errorCode: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly pageCount: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface FileExtraction {
  readonly fileId: string;
  readonly status: 'pending' | 'done' | 'failed' | 'unsupported';
  readonly extractor: string | null;
  readonly text: string | null;
  readonly charCount: number | null;
  readonly tokenEstimate: number | null;
  readonly truncated: boolean;
  readonly pageCount: number | null;
  readonly errorCode: string | null;
}

/** Stored attachment whose bytes are read lazily through the storage port. */
export interface AttachmentFileRef {
  readonly fileId: string;
  readonly mimeType: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly pageCount?: number;
  read(): Promise<Uint8Array>;
  stream(): Promise<ReadableStream<Uint8Array>>;
}

export type ResolvedAttachmentPart =
  | { readonly type: 'image'; readonly file: AttachmentFileRef }
  | {
      readonly type: 'document';
      readonly file: AttachmentFileRef;
      readonly extractedText?: string;
      readonly preferNative: boolean;
    };

export const FILE_LIMITS = {
  /** Hard request-body cap across all file types. */
  maxBytes: 30 * 1024 * 1024,
  perType: {
    image: 10 * 1024 * 1024,
    pdf: 20 * 1024 * 1024,
    docx: 10 * 1024 * 1024,
    xlsx: 10 * 1024 * 1024,
    csv: 5 * 1024 * 1024,
    text: 2 * 1024 * 1024,
  },
  maxImagePixels: 40_000_000, // 8000×8000, so a small file cannot decode into gigabytes
  maxImageDimension: 8000,
  /** OOXML zip-bomb guards. */
  zip: {
    maxEntries: 2_000,
    maxUncompressedBytes: 100 * 1024 * 1024,
    maxCompressionRatio: 100,
  },
  pdfMaxPages: 100,
} as const;

/** Files the MVP accepts for upload — detected by magic bytes, not extension. */
export const SUPPORTED_UPLOAD_KINDS = [
  'png',
  'jpeg',
  'webp',
  'gif',
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'text',
] as const;
export type SupportedUploadKind = (typeof SUPPORTED_UPLOAD_KINDS)[number];

const MIME_BY_KIND: Record<SupportedUploadKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  text: 'text/plain',
};

export function mimeForKind(kind: SupportedUploadKind): string {
  return MIME_BY_KIND[kind];
}

const MAX_DISPLAY_NAME = 120;

export function sanitizeDisplayName(raw: string): string {
  const stripped = raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    // Strip bidi/zero-width characters that can spoof extensions.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    // Collapse `..` runs and drop leading/trailing dots: no traversal fragments survive even
    // after separators are removed (`../../etc/passwd` → `etcpasswd`).
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return 'file';
  return stripped.length <= MAX_DISPLAY_NAME ? stripped : stripped.slice(0, MAX_DISPLAY_NAME);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  // Reject obvious binary noise even when it happens to decode.
  let control = 0;
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / Math.max(1, decoded.length) < 0.05;
}

/** Sniffs the upload kind from magic leading bytes. Returns null if unsupported. */
export function detectUploadKind(bytes: Uint8Array): SupportedUploadKind | null {
  if (bytes.byteLength === 0) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'webp';
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  // OOXML = a ZIP whose first local-file header usually starts with PK\x03\x04.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    if (head.includes('word/')) return 'docx';
    if (head.includes('xl/')) return 'xlsx';
    return null; // generic zip is not an accepted upload type
  }
  if (isUtf8Text(bytes)) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048));
    const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
    if (firstLine.includes(',') && head.includes('\n')) return 'csv';
    return 'text';
  }
  return null;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function probeImageDimensions(
  kind: SupportedUploadKind,
  bytes: Uint8Array,
): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (kind === 'png' && bytes.length >= 24) {
    // IHDR is the first chunk: 8-byte signature + 4 len + 'IHDR' + 4 w + 4 h.
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (kind === 'gif' && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (kind === 'jpeg') {
    // Walk JPEG segments until an SOFn marker carries the dimensions.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker: number = bytes[offset + 1] ?? 0;
      const length = view.getUint16(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }

  if (kind === 'webp' && bytes.length >= 30) {
    const format = new TextDecoder('latin1').decode(bytes.subarray(12, 16));
    if (format === 'VP8 ') {
      // lossy: dimensions at offset 26 (14-bit values).
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (format === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === 'VP8X') {
      const w = bytes[24] ?? 0;
      const wMid = bytes[25] ?? 0;
      const wHigh = bytes[26] ?? 0;
      const h = bytes[27] ?? 0;
      const hMid = bytes[28] ?? 0;
      const hHigh = bytes[29] ?? 0;
      return {
        width: (w | (wMid << 8) | (wHigh << 16)) + 1,
        height: (h | (hMid << 8) | (hHigh << 16)) + 1,
      };
    }
  }

  return null;
}

/** Rejects animated GIFs: the MVP renders static images only. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  let count = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x2c) {
      count += 1;
      if (count > 1) return true;
      i += 1;
    }
  }
  return false;
}

export interface ZipInspection {
  readonly entries: number;
  readonly totalUncompressedBytes: number;
  readonly hasMacros: boolean;
  readonly encrypted: boolean;
}

/** Minimal end-of-central-directory + central-directory walk. No extraction, no inflation. */
export function inspectZip(bytes: Uint8Array): ZipInspection | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('latin1');

  // Locate the End Of Central Directory record (scanning backwards past the comment).
  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 66 - 65_536);
  for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  let entries = 0;
  let totalUncompressedBytes = 0;
  let hasMacros = false;
  let encrypted = false;

  let offset = cdOffset;
  while (offset + 46 <= bytes.length && entries < entryCount) {
    if (!(
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x01 &&
      bytes[offset + 3] === 0x02
    )) {
      break;
    }
    const flags = view.getUint16(offset + 8, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    entries += 1;
    totalUncompressedBytes += uncompressedSize;
    if ((flags & 0x1) !== 0) encrypted = true;
    if (name.endsWith('vbaProject.bin')) hasMacros = true;

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, totalUncompressedBytes, hasMacros, encrypted };
}

export interface PdfInspection {
  readonly encrypted: boolean;
  readonly hasJavascript: boolean;
  readonly pageCount: number | null;
}

export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const decoder = new TextDecoder('latin1');
  const head = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));

  // PDF names may hex-escape any character (`/J#61vaScript`); decode before keyword matching.
  const normalized = head.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

  const encrypted =
    normalized.includes('/Encrypt') && !/\/EncryptMetadata\s+false(?![A-Za-z0-9])/.test(normalized)
      ? true
      : /\/Filter\s*\/Standard/.test(normalized);
  // `/JS` is the script entry key; `/JavaScript` is the action type. Names end at delimiters,
  // so a following alphanumeric means a different name (`/JSFoo`) and must not match.
  const hasJavascript = /\/(?:JavaScript|JS)(?![A-Za-z0-9])/.test(normalized);

  // Count /Type /Page (not /Pages) markers in the tail where the page tree lives.
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 1024 * 1024)));
  const pageMatches = tail.match(/\/Type\s*\/Page[^s]/g);
  const pageCount = pageMatches !== null ? pageMatches.length : null;

  return { encrypted, hasJavascript, pageCount };
}

export interface UploadValidationRequest {
  readonly kind: SupportedUploadKind;
  readonly bytes: Uint8Array;
  readonly declaredMime: string | null;
}

export interface UploadValidationResult {
  readonly detectedMime: string;
  readonly kind: AttachmentKind;
  readonly width: number | null;
  readonly height: number | null;
  readonly pageCount: number | null;
}

function isMimeCompatible(declared: string, detected: string): boolean {
  const normDeclared = declared.toLowerCase().split(';')[0]?.trim();
  const normDetected = detected.toLowerCase().split(';')[0]?.trim();
  if (!normDeclared || normDeclared === 'application/octet-stream') return true;
  if (normDeclared === normDetected) return true;
  if (normDeclared.startsWith('text/') && normDetected?.startsWith('text/')) return true;
  return false;
}

/** Validates upload bytes, size limits, dimensions, and MIME consistency. */
export function validateUpload(request: UploadValidationRequest): UploadValidationResult {
  const { kind, bytes } = request;

  if (bytes.byteLength === 0) {
    throw new AttachmentValidationError('unsupported_file_type', 'The file is empty.');
  }
  const detectedMime = mimeForKind(kind);
  if (request.declaredMime && !isMimeCompatible(request.declaredMime, detectedMime)) {
    throw new AttachmentValidationError(
      'unsupported_file_type',
      `Declared MIME type "${request.declaredMime}" does not match detected content type "${detectedMime}".`,
    );
  }
  const perTypeCap =
    kind === 'png' || kind === 'jpeg' || kind === 'webp' || kind === 'gif'
      ? FILE_LIMITS.perType.image
      : kind === 'pdf'
        ? FILE_LIMITS.perType.pdf
        : kind === 'docx'
          ? FILE_LIMITS.perType.docx
          : kind === 'xlsx'
            ? FILE_LIMITS.perType.xlsx
            : kind === 'csv'
              ? FILE_LIMITS.perType.csv
              : FILE_LIMITS.perType.text;
  if (bytes.byteLength > perTypeCap) {
    throw new AttachmentValidationError('file_too_large', 'The file exceeds the size limit for its type.');
  }

  // Header bytes only: a pixel bomb must be rejected before anything decodes the image.
  const isImage = kind === 'png' || kind === 'jpeg' || kind === 'webp' || kind === 'gif';
  let width: number | null = null;
  let height: number | null = null;
  if (isImage) {
    const dims = probeImageDimensions(kind, bytes);
    if (dims === null) {
      throw new AttachmentValidationError('unsupported_file_type', 'The image header could not be read.');
    }
    if (
      dims.width > FILE_LIMITS.maxImageDimension ||
      dims.height > FILE_LIMITS.maxImageDimension ||
      dims.width * dims.height > FILE_LIMITS.maxImagePixels
    ) {
      throw new AttachmentValidationError('unsupported_file_type', 'The image dimensions exceed the limit.');
    }
    if (kind === 'gif' && isAnimatedGif(bytes)) {
      throw new AttachmentValidationError('unsupported_file_type', 'Animated images are not supported.');
    }
    width = dims.width;
    height = dims.height;
  }

  let pageCount: number | null = null;
  if (kind === 'docx' || kind === 'xlsx') {
    const zip = inspectZip(bytes);
    if (zip === null) {
      throw new AttachmentValidationError(
        'unsupported_file_type',
        'The document archive is not a valid OOXML file.',
      );
    }
    if (zip.encrypted) {
      throw new AttachmentValidationError('unsupported_file_type', 'Encrypted documents are not supported.');
    }
    if (zip.hasMacros) {
      throw new AttachmentValidationError('unsupported_file_type', 'Macro-enabled documents are not supported.');
    }
    if (
      zip.entries > FILE_LIMITS.zip.maxEntries ||
      zip.totalUncompressedBytes > FILE_LIMITS.zip.maxUncompressedBytes ||
      (zip.totalUncompressedBytes > 0 &&
        bytes.byteLength > 0 &&
        zip.totalUncompressedBytes / bytes.byteLength > FILE_LIMITS.zip.maxCompressionRatio)
    ) {
      throw new AttachmentValidationError('file_too_large', 'The document archive exceeds the expansion limits.');
    }
  }

  if (kind === 'pdf') {
    const pdf = inspectPdf(bytes);
    if (pdf.encrypted) {
      throw new AttachmentValidationError('unsupported_file_type', 'Password-protected PDFs are not supported.');
    }
    if (pdf.hasJavascript) {
      throw new AttachmentValidationError(
        'unsupported_file_type',
        'PDFs with embedded JavaScript are not supported.',
      );
    }
    if (pdf.pageCount !== null && pdf.pageCount > FILE_LIMITS.pdfMaxPages) {
      throw new AttachmentValidationError(
        'unsupported_file_type',
        `PDFs over ${FILE_LIMITS.pdfMaxPages} pages are not supported.`,
      );
    }
    pageCount = pdf.pageCount;
  }

  return {
    detectedMime,
    kind: isImage
      ? 'image'
      : kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'csv' || kind === 'text'
        ? 'document'
        : 'other',
    width,
    height,
    pageCount,
  };
}

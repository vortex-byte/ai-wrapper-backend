import { describe, expect, it } from 'vitest';
import {
  FILE_LIMITS,
  detectUploadKind,
  inspectPdf,
  inspectZip,
  isAnimatedGif,
  probeImageDimensions,
  sanitizeDisplayName,
  validateUpload,
} from '@/attachments/domain/attachment.ts';
import { AppError } from '@/errors.ts';

const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(width: number, height: number, totalLength = 100): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(pngHeader, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('detectUploadKind', () => {
  it('detects images by magic bytes, not extension', () => {
    expect(detectUploadKind(pngBytes(10, 10))).toBe('png');
    expect(detectUploadKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect(detectUploadKind(gif)).toBe('gif');
  });

  it('detects PDF and OOXML containers', () => {
    expect(detectUploadKind(new TextEncoder().encode('%PDF-1.7 ...'))).toBe('pdf');
  });

  it('returns null for unknown binary and empty inputs', () => {
    expect(detectUploadKind(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(detectUploadKind(new Uint8Array(0))).toBeNull();
  });

  it('detects utf-8 text and csv', () => {
    expect(detectUploadKind(new TextEncoder().encode('hello world\nsecond line'))).toBe('text');
    expect(detectUploadKind(new TextEncoder().encode('a,b,c\n1,2,3\n'))).toBe('csv');
  });
});

describe('sanitizeDisplayName', () => {
  it('strips path separators, control and bidi characters', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeDisplayName('..\\..\\windows\\system32')).toBe('windowssystem32');
    expect(sanitizeDisplayName('report\u202Exe.pdf')).toBe('reportxe.pdf');
    expect(sanitizeDisplayName('a\u0000b\u0007c')).toBe('abc');
  });

  it('never leaves a traversal fragment or a hidden-file prefix', () => {
    expect(sanitizeDisplayName('..')).toBe('file');
    expect(sanitizeDisplayName('.hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeDisplayName('archive..pdf')).toBe('archive.pdf');
  });

  it('falls back to "file" for empty names and caps length', () => {
    expect(sanitizeDisplayName('   ')).toBe('file');
    expect(sanitizeDisplayName('x'.repeat(500)).length).toBe(120);
  });
});

describe('probeImageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(probeImageDimensions('png', pngBytes(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('returns null for truncated headers', () => {
    expect(probeImageDimensions('png', new Uint8Array(10))).toBeNull();
  });
});

describe('isAnimatedGif', () => {
  it('flags multiple image separators', () => {
    const single = new TextEncoder().encode('GIF89a\x00\x2cframe');
    expect(isAnimatedGif(single)).toBe(false);
    const multi = new TextEncoder().encode('GIF89a\x00\x2ca\x00\x2cb');
    expect(isAnimatedGif(multi)).toBe(true);
  });
});

describe('inspectZip / OOXML guards', () => {
  it('returns null for non-zip bytes', () => {
    expect(inspectZip(pngBytes(1, 1))).toBeNull();
  });
});

describe('inspectPdf', () => {
  it('flags encrypted and JS-bearing PDFs', () => {
    const encrypted = inspectPdf(new TextEncoder().encode('%PDF-1.4 /Encrypt /Filter /Standard'));
    expect(encrypted.encrypted).toBe(true);
    const js = inspectPdf(new TextEncoder().encode('%PDF-1.4 /JavaScript'));
    expect(js.hasJavascript).toBe(true);
  });
});

describe('validateUpload', () => {
  it('accepts a well-formed small PNG and reports dimensions', () => {
    const result = validateUpload({ kind: 'png', bytes: pngBytes(64, 64), declaredMime: 'image/png' });
    expect(result.detectedMime).toBe('image/png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
  });

  it('rejects pixel bombs over the dimension cap', () => {
    expect(() =>
      validateUpload({
        kind: 'png',
        bytes: pngBytes(FILE_LIMITS.maxImageDimension + 1, 10),
        declaredMime: null,
      }),
    ).toThrowError(AppError);
  });

  it('rejects empty and oversized uploads', () => {
    expect(() => validateUpload({ kind: 'png', bytes: new Uint8Array(0), declaredMime: null })).toThrowError(
      AppError,
    );
    expect(() =>
      validateUpload({ kind: 'text', bytes: new Uint8Array(FILE_LIMITS.perType.text + 1).fill(0x61), declaredMime: null }),
    ).toThrowError(AppError);
  });
});

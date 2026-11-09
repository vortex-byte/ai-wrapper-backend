import { MIME_BY_EXTENSION } from './config.ts';

export function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (isSvg(bytes)) return 'image/svg+xml';
  return null;
}

/** SVG is text: the signature is optional BOM/whitespace/XML prolog followed by `<svg`. */
function isSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

export function mimeFromFilename(filename: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  if (match?.[1] === undefined) return undefined;
  return MIME_BY_EXTENSION[match[1].toLowerCase()];
}

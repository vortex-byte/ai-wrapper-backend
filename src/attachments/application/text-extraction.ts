/** Text extraction for input documents into bounded Markdown text. */

import { formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc';
import type { Format } from '@firecrawl/anydoc';
import type { SupportedUploadKind } from '../domain/attachment.ts';

export interface ExtractionResult {
  readonly extractor: string;
  readonly text: string | null;
  readonly truncated: boolean;
  readonly pageCount: number | null;
  readonly status: 'done' | 'failed' | 'unsupported';
  readonly errorCode?: string | undefined;
}

const MAX_CHARS = 200_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHARS), truncated: true };
}

function failed(extractor: string, errorCode?: string): ExtractionResult {
  return {
    extractor,
    text: null,
    truncated: false,
    pageCount: null,
    status: 'failed',
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

/** Formats anydoc converts from content; `formatFromExtension` supplies the (typed) hint for signature-less CSV. */
function anydocFormatFor(kind: SupportedUploadKind): Format | null | undefined {
  switch (kind) {
    case 'docx':
      return formatFromExtension('docx');
    case 'xlsx':
      return formatFromExtension('xlsx');
    case 'pdf':
      return formatFromExtension('pdf');
    case 'csv':
      return formatFromExtension('csv');
    default:
      return null;
  }
}

export interface ExtractInput {
  readonly kind: SupportedUploadKind;
  readonly bytes: Uint8Array;
}

/** Extracts bounded Markdown text for the detected kind. */
export async function extractTextForKind(input: ExtractInput): Promise<ExtractionResult> {
  // Plain text needs no conversion; a plain decode is correct and cheapest.
  if (input.kind === 'text') {
    const { text, truncated } = truncate(
      new TextDecoder('utf-8', { fatal: false }).decode(input.bytes),
    );
    return { extractor: 'plain', text, truncated, pageCount: null, status: 'done' };
  }

  const format = anydocFormatFor(input.kind);
  if (format === null || format === undefined) {
    return {
      extractor: 'none',
      text: null,
      truncated: false,
      pageCount: null,
      status: 'unsupported',
    };
  }

  try {
    const markdown = await toMarkdownBytes(input.bytes, format, { ocr: 'reject' });
    const { text, truncated } = truncate(markdown);
    return { extractor: 'anydoc', text, truncated, pageCount: null, status: 'done' };
  } catch (err) {
    // anydoc errors carry a `code` (needsOcr, encrypted, resourceLimit, ...). Persisted
    // as the extraction's error_code; never the document content itself.
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    return failed('anydoc', code);
  }
}

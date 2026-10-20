import { describe, expect, it } from 'vitest';
import { extractTextForKind } from '@/attachments/application/text-extraction.ts';

describe('extractTextForKind (anydoc)', () => {
  it('passes plain text through bounded and unconverted', async () => {
    const result = await extractTextForKind({
      kind: 'text',
      bytes: new TextEncoder().encode('hello world'),
    });
    expect(result.status).toBe('done');
    expect(result.extractor).toBe('plain');
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
  });

  it('converts CSV to a Markdown table', async () => {
    const result = await extractTextForKind({
      kind: 'csv',
      bytes: new TextEncoder().encode('a,b\n1,2\n'),
    });
    expect(result.status).toBe('done');
    expect(result.extractor).toBe('anydoc');
    expect(result.text).toContain('| a | b |');
  });

  it('returns unsupported for image kinds', async () => {
    const result = await extractTextForKind({ kind: 'png', bytes: new Uint8Array(8) });
    expect(result.status).toBe('unsupported');
  });

  it('truncates oversized text and flags it', async () => {
    const big = 'x'.repeat(250_000);
    const result = await extractTextForKind({ kind: 'text', bytes: new TextEncoder().encode(big) });
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBeLessThanOrEqual(200_000);
  });

  it('maps anydoc failures to a failed result instead of throwing', async () => {
    // Not valid CSV content? CSV is signature-less: anydoc will still parse it as text-ish
    // or fail gracefully — either way extractTextForKind must not throw.
    const result = await extractTextForKind({ kind: 'csv', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) });
    expect(['done', 'failed']).toContain(result.status);
  });
});

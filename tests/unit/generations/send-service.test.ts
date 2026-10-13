import { describe, expect, it } from 'vitest';
import { canonicalRequestHash } from '@/generations/application/send-service.ts';

const CONV = '0192a000-0000-7000-8000-000000000001';

describe('canonicalRequestHash', () => {
  it('is stable for the same logical request', () => {
    const a = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hello' }], undefined);
    const b = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hello' }], undefined);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when the text changes', () => {
    const a = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hello' }], undefined);
    const b = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hello!' }], undefined);
    expect(a).not.toBe(b);
  });

  it('is order-sensitive across parts', () => {
    const a = canonicalRequestHash(
      CONV,
      [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
      undefined,
    );
    const b = canonicalRequestHash(
      CONV,
      [
        { type: 'text', text: 'two' },
        { type: 'text', text: 'one' },
      ],
      undefined,
    );
    expect(a).not.toBe(b);
  });

  it('changes when the conversation or options change', () => {
    const base = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hi' }], undefined);
    const otherConv = canonicalRequestHash(
      '0192a000-0000-7000-8000-000000000002',
      [{ type: 'text', text: 'Hi' }],
      undefined,
    );
    const withOptions = canonicalRequestHash(CONV, [{ type: 'text', text: 'Hi' }], {
      maxOutputTokens: 100,
    });
    expect(base).not.toBe(otherConv);
    expect(base).not.toBe(withOptions);
  });

  it('distinguishes a file part from a text part', () => {
    const text = canonicalRequestHash(CONV, [{ type: 'text', text: 'x' }], undefined);
    const file = canonicalRequestHash(
      CONV,
      [{ type: 'file', fileId: '0192a000-0000-7000-8000-000000000009' }],
      undefined,
    );
    expect(text).not.toBe(file);
  });
});

import { describe, expect, it } from 'vitest';
import type { ModelCapabilities } from '@/providers/domain/capabilities.ts';
import { parseCapabilities } from '@/providers/domain/capabilities-schema.ts';
import { validatePartsForModel } from '@/providers/domain/capability-validation.ts';
import type { NormalizedPart } from '@/providers/domain/pal.ts';

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    ...parseCapabilities({ contextWindow: 8_192, maxOutputTokens: 1_024 }),
    ...overrides,
  };
}

const file = {
  fileId: 'f1',
  mimeType: 'image/png',
  name: 'chart.png',
  sizeBytes: 10,
  async read() {
    return new Uint8Array();
  },
  async stream() {
    return new ReadableStream<Uint8Array>();
  },
};

describe('capability validation (D-4)', () => {
  it('allows text on any model', () => {
    const parts: NormalizedPart[] = [{ type: 'text', text: 'hello' }];
    expect(validatePartsForModel(capabilities(), parts)).toEqual({ ok: true });
  });

  it('rejects an image for a non-vision model', () => {
    const parts: NormalizedPart[] = [{ type: 'image', file }];
    expect(validatePartsForModel(capabilities({ vision: false }), parts)).toEqual({
      ok: false,
      violation: 'image_not_supported',
    });
  });

  it('allows an image when vision is true', () => {
    const parts: NormalizedPart[] = [{ type: 'image', file }];
    expect(validatePartsForModel(capabilities({ vision: true }), parts)).toEqual({ ok: true });
  });

  it('rejects too many images when a cap is declared', () => {
    const parts: NormalizedPart[] = [
      { type: 'image', file },
      { type: 'image', file },
      { type: 'image', file },
    ];
    expect(
      validatePartsForModel(capabilities({ vision: true, maxImagesPerRequest: 2 }), parts),
    ).toEqual({ ok: false, violation: 'too_many_images' });
  });

  it('rejects a document for a model without document support', () => {
    const parts: NormalizedPart[] = [
      { type: 'document', file, preferNative: true, extractedText: 'x' },
    ];
    expect(validatePartsForModel(capabilities({ documents: { pdf: false } }), parts)).toEqual({
      ok: false,
      violation: 'document_not_supported',
    });
  });
});

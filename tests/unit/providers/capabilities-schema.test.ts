import { describe, expect, it } from 'vitest';
import {
  parseCapabilities,
  toCapabilitiesJson,
  ModelCapabilitiesSchema,
} from '@/providers/domain/capabilities-schema.ts';

describe('capabilities schema', () => {
  it('applies safe defaults for the optional flags', () => {
    const parsed = parseCapabilities({ contextWindow: 8_192, maxOutputTokens: 1_024 });
    expect(parsed.streaming).toBe(true);
    expect(parsed.vision).toBe(false);
    expect(parsed.documents).toEqual({ pdf: false });
    expect(parsed.systemPrompt).toBe(true);
    expect(parsed.tools).toBe(false);
  });

  it('rejects a non-positive context window', () => {
    const result = ModelCapabilitiesSchema.safeParse({ contextWindow: 0, maxOutputTokens: 10 });
    expect(result.success).toBe(false);
  });

  it('round-trips through the persisted JSON shape with a schemaVersion', () => {
    const json = toCapabilitiesJson(parseCapabilities({ contextWindow: 4_096, maxOutputTokens: 512 }));
    expect(json.schemaVersion).toBe(1);

    const reparsed = parseCapabilities(json);
    expect(reparsed.contextWindow).toBe(4_096);
    expect(reparsed.maxOutputTokens).toBe(512);
  });

  it('preserves an explicit maxImagesPerRequest', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      vision: true,
      maxImagesPerRequest: 10,
    });
    expect(parsed.maxImagesPerRequest).toBe(10);
    expect(parsed.vision).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { SEED_MODELS } from '@/db/seed-data/providers-models.ts';
import {
  parseCapabilities,
  parsePartialCapabilities,
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

  it('falls back to provided contextWindow and maxOutputTokens if missing in capabilities', () => {
    const parsed = parseCapabilities(
      { schemaVersion: 1 },
      { contextWindow: 128_000, maxOutputTokens: 4_096 },
    );
    expect(parsed.contextWindow).toBe(128_000);
    expect(parsed.maxOutputTokens).toBe(4_096);
    expect(parsed.streaming).toBe(true);
  });

  it('parses partial capabilities without requiring contextWindow or maxOutputTokens', () => {
    const partial = parsePartialCapabilities({ vision: true });
    expect(partial.vision).toBe(true);
    expect(partial.contextWindow).toBeUndefined();
    expect(partial.maxOutputTokens).toBeUndefined();
  });

  it('leaves documents.pdf absent when a partial patch only touches maxPages', () => {
    const partial = parsePartialCapabilities({ documents: { maxPages: 40 } });
    expect(partial.documents).toEqual({ maxPages: 40 });
    expect(partial.documents?.pdf).toBeUndefined();
  });

  it('keeps an explicit documents.pdf value in a partial patch', () => {
    expect(parsePartialCapabilities({ documents: { pdf: true } }).documents).toEqual({ pdf: true });
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

  it('preserves an explicit maxImagesPerRequest on a vision model', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      vision: true,
      maxImagesPerRequest: 10,
    });
    expect(parsed.maxImagesPerRequest).toBe(10);
    expect(parsed.vision).toBe(true);
  });

  it('preserves an explicit maxImagesPerRequest alongside image generation', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      vision: true,
      imageGeneration: { mode: 'tool' },
      maxImagesPerRequest: 10,
    });
    expect(parsed.maxImagesPerRequest).toBe(10);
    expect(parsed.vision).toBe(true);
  });

  it('preserves an explicit maxImagesPerRequest on an image generation model without vision', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      vision: false,
      imageGeneration: { mode: 'provider' },
      maxImagesPerRequest: 4,
    });
    expect(parsed.maxImagesPerRequest).toBe(4);
    expect(parsed.imageGeneration).toEqual({ mode: 'provider' });
  });

  it('rejects maxImagesPerRequest on a model without vision or image generation', () => {
    expect(() =>
      parseCapabilities({
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
        vision: false,
        maxImagesPerRequest: 10,
      }),
    ).toThrow(/maxImagesPerRequest requires vision or imageGeneration/);
  });

  it('parses all seed model capabilities without error', () => {
    for (const model of SEED_MODELS) {
      expect(() =>
        parseCapabilities(model.capabilities, {
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        }),
      ).not.toThrow();
    }
  });

  it('parses a reasoning capability and requires the default to be selectable', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      reasoning: { availableEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    });
    expect(parsed.reasoning).toEqual({
      availableEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    });

    const outside = ModelCapabilitiesSchema.safeParse({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      reasoning: { availableEfforts: ['low'], defaultEffort: 'high' },
    });
    expect(outside.success).toBe(false);
  });

  it('treats a null reasoning capability as absent', () => {
    const parsed = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      reasoning: null,
    });
    expect(parsed.reasoning).toBeUndefined();
  });

  it('lets a partial patch clear reasoning with null', () => {
    expect(parsePartialCapabilities({ reasoning: null })).toEqual({ reasoning: null });
  });

  it('rejects an unknown effort value in a partial patch', () => {
    expect(() => parsePartialCapabilities({ reasoning: { defaultEffort: 'extreme' } })).toThrow();
  });

  it('parses image generation as a role and keeps an optional pinned model', () => {
    const tool = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: { mode: 'tool', model: 'gpt-image-2.5-flare' },
    });
    expect(tool.imageGeneration).toEqual({ mode: 'tool', model: 'gpt-image-2.5-flare' });

    const provider = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: { mode: 'provider' },
    });
    expect(provider.imageGeneration).toEqual({ mode: 'provider' });
  });

  it('reads the legacy boolean as the tool role', () => {
    const legacy = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: true,
    });
    expect(legacy.imageGeneration).toEqual({ mode: 'tool' });

    const absent = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: false,
    });
    expect(absent.imageGeneration).toBeNull();

    const cleared = parseCapabilities({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: null,
    });
    expect(cleared.imageGeneration).toBeNull();
  });

  it('lets a partial patch set, replace and clear the image capability', () => {
    expect(parsePartialCapabilities({ imageGeneration: true })).toEqual({
      imageGeneration: { mode: 'tool' },
    });
    expect(parsePartialCapabilities({ imageGeneration: { mode: 'provider' } })).toEqual({
      imageGeneration: { mode: 'provider' },
    });
    expect(parsePartialCapabilities({ imageGeneration: null })).toEqual({ imageGeneration: null });
    expect(parsePartialCapabilities({ imageGeneration: false })).toEqual({ imageGeneration: null });
  });

  it('allows maxImagesPerRequest to be cleared with null in partial patch', () => {
    expect(parsePartialCapabilities({ maxImagesPerRequest: null })).toEqual({
      maxImagesPerRequest: null,
    });
  });

  it('rejects an unknown image generation mode', () => {
    const result = ModelCapabilitiesSchema.safeParse({
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      imageGeneration: { mode: 'video' },
    });
    expect(result.success).toBe(false);
  });

  it('parses valid compaction capability with triggerTokens', () => {
    const parsed = parseCapabilities({
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      compaction: { triggerTokens: 100_000 },
    });
    expect(parsed.compaction).toEqual({ triggerTokens: 100_000 });
  });

  it('rejects compaction triggerTokens under 1,000', () => {
    const result = ModelCapabilitiesSchema.safeParse({
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      compaction: { triggerTokens: 500 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects compaction triggerTokens equal to or greater than contextWindow', () => {
    const resultEqual = ModelCapabilitiesSchema.safeParse({
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      compaction: { triggerTokens: 100_000 },
    });
    expect(resultEqual.success).toBe(false);

    const resultGreater = ModelCapabilitiesSchema.safeParse({
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      compaction: { triggerTokens: 120_000 },
    });
    expect(resultGreater.success).toBe(false);
  });
});

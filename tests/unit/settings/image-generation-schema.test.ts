import { describe, expect, it } from 'vitest';
import {
  ImageGenerationConfigSchema,
  parseSettingValue,
  KNOWN_SETTINGS,
} from '@/settings/domain/settings.ts';

describe('image generation settings schema', () => {
  it('holds only the rendering model per provider', () => {
    const parsed = ImageGenerationConfigSchema.parse({
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-nano-banana-2.1' },
      openai: { modelKey: 'gpt-image-2.5' },
    });
    expect(parsed).toEqual({
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-nano-banana-2.1' },
      openai: { modelKey: 'gpt-image-2.5' },
    });
  });

  it('rejects option fields, which belong to the chat composer', () => {
    for (const extra of [
      { aspectRatio: '16:9' },
      { imageSize: '2K' },
      { size: '1024x1024' },
      { quality: 'high' },
      { outputFormat: 'png' },
      { enabled: true },
    ]) {
      const provider = 'aspectRatio' in extra || 'imageSize' in extra ? 'gemini' : 'openai';
      expect(() =>
        ImageGenerationConfigSchema.parse({
          schemaVersion: 1,
          [provider]: { modelKey: 'some-image-model', ...extra },
        }),
      ).toThrow();
    }
  });

  it('accepts an unconfigured provider', () => {
    expect(ImageGenerationConfigSchema.parse({ schemaVersion: 1, gemini: {} })).toEqual({
      schemaVersion: 1,
      gemini: {},
    });
  });

  it('is the schema behind the known setting key', () => {
    const value = parseSettingValue(KNOWN_SETTINGS.imageGeneration, {
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-3-pro-image' },
    });
    expect(value).toEqual({ schemaVersion: 1, gemini: { modelKey: 'gemini-3-pro-image' } });
  });
});

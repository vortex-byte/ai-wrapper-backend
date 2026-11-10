import { KNOWN_SETTINGS, type ImageGenerationConfig } from '@/settings/domain/settings.ts';
import type { SettingsService } from '@/settings/application/settings-service.ts';
import type { ModelRecord } from '../domain/registry.ts';
import { configuredModelKey } from './image-generation-config.ts';

const SETTING_LABELS: Readonly<Record<'gemini' | 'openai', string>> = {
  gemini: 'the Gemini image generation setting',
  openai: 'the OpenAI image generation setting',
};

/** Names the settings entry using this model to render images, or `null` when nothing does; admin edits that would break it are rejected with it. */
export function createConfiguredImageModelLookup(
  settings: SettingsService,
): (model: ModelRecord) => Promise<string | null> {
  return async (model) => {
    const setting = await settings.get<ImageGenerationConfig>(KNOWN_SETTINGS.imageGeneration);
    const config = setting?.value;
    if (config === undefined) return null;

    for (const providerKey of ['gemini', 'openai'] as const) {
      const modelKey = configuredModelKey(providerKey, config);
      if (modelKey === null) continue;
      if (modelKey === model.apiModelId || modelKey === model.id) return SETTING_LABELS[providerKey];
    }
    return null;
  };
}

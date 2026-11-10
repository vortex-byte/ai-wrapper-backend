import { describe, expect, it } from 'vitest';
import type { ModelRecord } from '@/providers/domain/registry.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';
import type { ImageGenerationConfig } from '@/settings/domain/settings.ts';
import {
  configuredImageModel,
  imageOutputOptionsOf,
  imageOutputSurface,
  resolveRoutedImageModel,
  toolImageModel,
  validateImageGenerationConfig,
} from '@/providers/application/image-generation-config.ts';

function model(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: 'model-chat',
    providerId: 'provider-gemini',
    providerKey: 'gemini',
    providerDisplayName: 'Google Gemini',
    providerStatus: 'active',
    apiModelId: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    description: null,
    status: 'active',
    capabilities: {
      streaming: true,
      vision: true,
      documents: { pdf: true },
      imageGeneration: { mode: 'tool' },
      documentGeneration: false,
      systemPrompt: true,
      tools: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
    },
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    defaultMaxOutputTokens: 16_384,
    quotaWeight: 1,
    config: {},
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function imageModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return model({
    id: 'model-image',
    apiModelId: 'gemini-nano-banana-2.1',
    displayName: 'Nano Banana 2.1',
    config: {
      imageOutputOptions: {
        aspectRatios: ['1:1', '16:9'],
        imageSizes: ['1K', '2K'],
      },
    },
    ...overrides,
  });
}

function openAiChat(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return model({
    id: 'model-openai-chat',
    providerId: 'provider-openai',
    providerKey: 'openai',
    providerDisplayName: 'OpenAI',
    apiModelId: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    ...overrides,
  });
}

function registryOf(models: readonly ModelRecord[]): ModelRegistry {
  const unused = (): never => {
    throw new Error('not used');
  };
  return {
    listVisibleModels: () => Promise.resolve(models),
    listAllModels: () => Promise.resolve(models),
    listAllProviders: () => Promise.resolve([]),
    getRuntimeConfig: unused,
    invalidate: () => undefined,
  } as unknown as ModelRegistry;
}

const geminiConfig: ImageGenerationConfig = {
  schemaVersion: 1,
  gemini: { modelKey: 'gemini-nano-banana-2.1' },
};

describe('configuredImageModel', () => {
  it('resolves the admin-picked model by apiModelId', async () => {
    const found = await configuredImageModel(
      registryOf([model(), imageModel()]),
      'gemini',
      geminiConfig,
    );
    expect(found?.id).toBe('model-image');
  });

  it('resolves by row id too', async () => {
    const found = await configuredImageModel(
      registryOf([model(), imageModel()]),
      'gemini',
      { schemaVersion: 1, gemini: { modelKey: 'model-image' } },
    );
    expect(found?.id).toBe('model-image');
  });

  it('is null without a configured key for that provider', async () => {
    const registry = registryOf([model(), imageModel()]);
    expect(await configuredImageModel(registry, 'openai', geminiConfig)).toBeNull();
    expect(await configuredImageModel(registry, 'gemini', undefined)).toBeNull();
  });

  it('is null when the configured model is disabled or gone', async () => {
    expect(
      await configuredImageModel(
        registryOf([model(), imageModel({ status: 'disabled' })]),
        'gemini',
        geminiConfig,
      ),
    ).toBeNull();
    expect(
      await configuredImageModel(
        registryOf([model()]),
        'gemini',
        { schemaVersion: 1, gemini: { modelKey: 'gemini-dos' } },
      ),
    ).toBeNull();
  });

  it('never borrows a model from another provider', async () => {
    expect(
      await configuredImageModel(registryOf([imageModel()]), 'openai', {
        schemaVersion: 1,
        openai: { modelKey: 'gemini-nano-banana-2.1' },
      }),
    ).toBeNull();
  });
});

describe('resolveRoutedImageModel', () => {
  it('routes a Gemini chat model to the configured image model', async () => {
    const routed = await resolveRoutedImageModel({
      registry: registryOf([model(), imageModel()]),
      conversationModel: model(),
      imageGeneration: geminiConfig,
    });
    expect(routed?.model.id).toBe('model-image');
    expect(routed?.options).toEqual({});
  });

  it('never routes geometry: the user chooses it per turn', async () => {
    const routed = await resolveRoutedImageModel({
      registry: registryOf([model(), imageModel()]),
      conversationModel: model(),
      imageGeneration: geminiConfig,
    });
    expect(routed?.options.aspectRatio).toBeUndefined();
    expect(routed?.options.imageSize).toBeUndefined();
  });

  it('does not route when the conversation model cannot call the image tool', async () => {
    const noImages = model({ capabilities: { ...model().capabilities, imageGeneration: null } });
    expect(
      await resolveRoutedImageModel({
        registry: registryOf([noImages, imageModel()]),
        conversationModel: noImages,
        imageGeneration: geminiConfig,
      }),
    ).toBeNull();
  });

  it('does not route when nothing is configured', async () => {
    expect(
      await resolveRoutedImageModel({
        registry: registryOf([model(), imageModel()]),
        conversationModel: model(),
        imageGeneration: undefined,
      }),
    ).toBeNull();
  });
});

describe('toolImageModel', () => {
  it('names the configured OpenAI image model for the tool', async () => {
    const image = model({
      id: 'model-openai-image',
      providerId: 'provider-openai',
      providerKey: 'openai',
      apiModelId: 'gpt-image-2.5',
      displayName: 'GPT Image 2.5',
    });
    expect(
      await toolImageModel(registryOf([openAiChat(), image]), 'openai', {
        schemaVersion: 1,
        openai: { modelKey: 'gpt-image-2.5' },
      }),
    ).toBe('gpt-image-2.5');
  });

  it('is undefined when the provider has no configured image model', async () => {
    expect(await toolImageModel(registryOf([openAiChat()]), 'openai', geminiConfig)).toBeUndefined();
  });
});

describe('imageOutputOptionsOf', () => {
  it('reads the admin-config option list', () => {
    expect(imageOutputOptionsOf(imageModel())).toEqual({
      aspectRatios: ['1:1', '16:9'],
      imageSizes: ['1K', '2K'],
    });
  });

  it('falls back to the full defaults when unconfigured', () => {
    const options = imageOutputOptionsOf(imageModel({ config: {} }));
    expect(options.aspectRatios).toHaveLength(10);
    expect(options.imageSizes).toEqual(['1K', '2K', '4K']);
  });
});

describe('imageOutputSurface', () => {
  it('exposes the routed Gemini model and its options to the composer', async () => {
    const surface = await imageOutputSurface(
      registryOf([model(), imageModel()]),
      model(),
      geminiConfig,
    );
    expect(surface).toEqual({
      target: 'routed',
      imageModel: { id: 'model-image', displayName: 'Nano Banana 2.1' },
      aspectRatios: ['1:1', '16:9'],
      imageSizes: ['1K', '2K'],
    });
  });

  it('exposes the OpenAI chat model as the tool target', async () => {
    const chat = openAiChat();
    const image = openAiChat({
      id: 'model-openai-image',
      apiModelId: 'gpt-image-2.5',
      displayName: 'GPT Image 2.5',
    });
    const surface = await imageOutputSurface(
      registryOf([chat, image]),
      chat,
      { schemaVersion: 1, openai: { modelKey: 'gpt-image-2.5' } },
    );
    expect(surface?.target).toBe('tool');
    expect(surface?.imageModel.id).toBe(chat.id);
  });

  it('is null when the provider has no configured image model', async () => {
    expect(
      await imageOutputSurface(registryOf([model(), imageModel()]), model(), { schemaVersion: 1 }),
    ).toBeNull();
  });

  it('is null when the conversation model cannot call the image tool', async () => {
    const noImages = model({ capabilities: { ...model().capabilities, imageGeneration: null } });
    expect(
      await imageOutputSurface(registryOf([noImages, imageModel()]), noImages, geminiConfig),
    ).toBeNull();
  });
});

describe('validateImageGenerationConfig', () => {
  it('accepts an empty config', () => {
    expect(validateImageGenerationConfig({ schemaVersion: 1 })).toBeNull();
  });

  it('accepts catalog models for both providers', () => {
    expect(
      validateImageGenerationConfig({
        schemaVersion: 1,
        gemini: { modelKey: 'gemini-nano-banana-2.1' },
        openai: { modelKey: 'gpt-image-2.5-flare' },
      }),
    ).toBeNull();
  });

  it('rejects a model outside its provider catalog', () => {
    expect(
      validateImageGenerationConfig({ schemaVersion: 1, gemini: { modelKey: 'gemini-dos' } }),
    ).toContain('Unknown gemini image model');
  });

  it('rejects a Gemini model named for OpenAI', () => {
    expect(
      validateImageGenerationConfig({
        schemaVersion: 1,
        openai: { modelKey: 'gemini-nano-banana-2.1' },
      }),
    ).toContain('Unknown openai image model');
  });
});

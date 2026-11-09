import { describe, expect, it } from 'vitest';
import { toWireModel } from '@/providers/http/model-routes.ts';
import type { ModelRecord } from '@/providers/domain/registry.ts';

function model(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: 'm-1',
    providerId: 'p-1',
    providerKey: 'openai',
    providerDisplayName: 'OpenAI',
    providerStatus: 'active',
    apiModelId: 'gpt-5.1',
    displayName: 'GPT-5.1',
    description: null,
    status: 'active',
    capabilities: {
      streaming: true,
      vision: true,
      documents: { pdf: true },
      documentGeneration: false,
      systemPrompt: true,
      tools: true,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    defaultMaxOutputTokens: 8_192,
    quotaWeight: 1,
    config: {},
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('toWireModel limits', () => {
  it('allows image parts on a vision model that cannot generate images', () => {
    const wire = toWireModel(model());
    expect(wire.limits.maxImagesPerMessage).toBe(10);
    expect(wire.limits.maxFilesPerMessage).toBe(5);
  });

  it('honours maxImagesPerRequest when the model declares a cap', () => {
    const wire = toWireModel(
      model({
        capabilities: {
          ...model().capabilities,
          imageGeneration: { mode: 'tool' },
          maxImagesPerRequest: 2,
        },
      }),
    );
    expect(wire.limits.maxImagesPerMessage).toBe(2);
  });

  it('defaults an uncapped but image-capable vision model to ten', () => {
    const wire = toWireModel(
      model({ capabilities: { ...model().capabilities, imageGeneration: { mode: 'tool' } } }),
    );
    expect(wire.limits.maxImagesPerMessage).toBe(10);
  });

  it('reports no image limit for an image endpoint', () => {
    const wire = toWireModel(
      model({
        capabilities: {
          ...model().capabilities,
          imageGeneration: { mode: 'provider' },
        },
      }),
    );
    expect(wire.limits.maxImagesPerMessage).toBe(0);
  });
});

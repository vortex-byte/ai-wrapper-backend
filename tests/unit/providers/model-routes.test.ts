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
    providerAdapter: 'openai',
    apiModelId: 'gpt-5.1',
    displayName: 'GPT-5.1',
    description: null,
    status: 'active',
    capabilities: {
      streaming: true,
      vision: true,
      documents: { pdf: true },
      imageGeneration: null,
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

  it('reports zero image limit for an image-generating model without vision', () => {
    const wire = toWireModel(
      model({
        capabilities: {
          ...model().capabilities,
          vision: false,
          imageGeneration: { mode: 'tool' },
          maxImagesPerRequest: 4,
        },
      }),
    );
    expect(wire.limits.maxImagesPerMessage).toBe(0);
  });
});

const LOCAL_CONFIG = {
  local: {
    webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    tier: 'small',
    downloadSizeBytes: 880_000_000,
    vramRequiredMB: 1_100,
    license: 'Llama 3.2 Community License',
    sourceRevision: 'main',
    requiredFeatures: ['shader-f16'],
  },
};

describe('toWireModel execution', () => {
  it('marks a server model as server-executed with no local metadata', () => {
    const wire = toWireModel(model());
    expect(wire.execution).toBe('server');
    expect(wire.local).toBeNull();
  });

  it('marks a local model as client-executed and exposes its runtime metadata', () => {
    const wire = toWireModel(
      model({
        providerAdapter: 'local',
        apiModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        config: LOCAL_CONFIG,
      }),
    );
    expect(wire.execution).toBe('client');
    expect(wire.local).toEqual({
      webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      tier: 'small',
      downloadSizeBytes: 880_000_000,
      vramRequiredMB: 1_100,
      license: 'Llama 3.2 Community License',
      requiredFeatures: ['shader-f16'],
    });
  });

  it('never exposes file or image limits for a local model', () => {
    const wire = toWireModel(
      model({
        providerAdapter: 'local',
        capabilities: { ...model().capabilities, vision: true },
        config: LOCAL_CONFIG,
      }),
    );
    expect(wire.limits.maxFilesPerMessage).toBe(0);
    expect(wire.limits.maxImagesPerMessage).toBe(0);
  });

  it('keeps a local model client-executed when its local metadata is invalid', () => {
    const wire = toWireModel(model({ providerAdapter: 'local', config: { local: {} } }));
    expect(wire.execution).toBe('client');
    expect(wire.local).toBeNull();
  });
});

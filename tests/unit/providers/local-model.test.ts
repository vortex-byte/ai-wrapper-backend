import { describe, expect, it } from 'vitest';
import type { ModelCapabilities } from '@/providers/domain/capabilities.ts';
import {
  isLocalAdapter,
  LOCAL_ADAPTER_KEY,
  LOCAL_MODEL_TIERS,
  LOCAL_PROVIDER_SECRET_REF,
  readLocalModelInfo,
  validateLocalCapabilities,
} from '@/providers/domain/local-model.ts';

const LOCAL_CONFIG = {
  local: {
    webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    tier: 'small',
    downloadSizeBytes: 880_000_000,
    vramRequiredMB: 1_100,
    sourceRevision: 'main',
    requiredFeatures: ['shader-f16'],
  },
};

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    streaming: true,
    vision: false,
    documents: { pdf: false },
    imageGeneration: null,
    documentGeneration: false,
    systemPrompt: true,
    tools: false,
    contextWindow: 8_192,
    maxOutputTokens: 2_048,
    ...overrides,
  };
}

describe('isLocalAdapter', () => {
  it('matches only the local adapter key', () => {
    expect(isLocalAdapter(LOCAL_ADAPTER_KEY)).toBe(true);
    expect(isLocalAdapter('openai')).toBe(false);
    expect(isLocalAdapter('Local')).toBe(false);
  });
});

describe('readLocalModelInfo', () => {
  it('reads a valid config.local block', () => {
    const info = readLocalModelInfo(LOCAL_CONFIG);
    expect(info).toEqual({
      webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      tier: 'small',
      downloadSizeBytes: 880_000_000,
      vramRequiredMB: 1_100,
        sourceRevision: 'main',
      requiredFeatures: ['shader-f16'],
    });
  });

  it('returns null when the block is absent', () => {
    expect(readLocalModelInfo({})).toBeNull();
  });

  it('returns null when the block is invalid', () => {
    expect(readLocalModelInfo({ local: { tier: 'small' } })).toBeNull();
    expect(readLocalModelInfo({ local: { ...LOCAL_CONFIG.local, tier: 'enormous' } })).toBeNull();
  });

  it('rejects unknown keys, so retired metadata must be migrated away', () => {
    expect(readLocalModelInfo({ local: { ...LOCAL_CONFIG.local, license: 'MIT' } })).toBeNull();
  });

  it('defaults requiredFeatures to an empty list', () => {
    const info = readLocalModelInfo({
      local: {
        webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        tier: 'small',
        downloadSizeBytes: 880_000_000,
        vramRequiredMB: 1_100,
            sourceRevision: 'main',
      },
    });
    expect(info?.requiredFeatures).toEqual([]);
  });
});

describe('validateLocalCapabilities', () => {
  it('accepts a text-only model', () => {
    expect(validateLocalCapabilities(capabilities())).toEqual([]);
  });

  it('rejects vision, documents, tools, and generation capabilities', () => {
    const violations = validateLocalCapabilities(
      capabilities({
        vision: true,
        documents: { pdf: true },
        tools: true,
        imageGeneration: { mode: 'tool' },
        documentGeneration: true,
      }),
    );
    expect(violations).toContain('vision must be disabled');
    expect(violations).toContain('document input must be disabled');
    expect(violations).toContain('tools must be disabled');
    expect(violations).toContain('image generation must be disabled');
    expect(violations).toContain('document generation must be disabled');
  });

  it('requires streaming and a system prompt', () => {
    const violations = validateLocalCapabilities(
      capabilities({ streaming: false, systemPrompt: false }),
    );
    expect(violations).toContain('streaming must be enabled');
    expect(violations).toContain('system prompt must be enabled');
  });
});

describe('local constants', () => {
  it('exposes the four size tiers', () => {
    expect(LOCAL_MODEL_TIERS).toEqual(['small', 'standard', 'balanced', 'high']);
  });

  it('uses a placeholder secret ref that is never a real credential', () => {
    expect(LOCAL_PROVIDER_SECRET_REF).toBe('UNUSED_LOCAL_KEY');
  });
});

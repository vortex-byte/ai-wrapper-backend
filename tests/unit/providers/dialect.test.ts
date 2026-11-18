import { describe, expect, it } from 'vitest';
import {
  COMPAT_ANTHROPIC_VERSION,
  resolveDialect,
  validateCapabilitiesForDialect,
  type ProviderDialectInput,
} from '@/providers/domain/dialect.ts';

function provider(overrides: Partial<ProviderDialectInput> = {}): ProviderDialectInput {
  return {
    adapter: 'openai',
    config: {},
    ...overrides,
  };
}

describe('resolveDialect', () => {
  it('keeps first-party OpenAI on the full feature set', () => {
    const dialect = resolveDialect(provider({ baseUrl: 'https://api.openai.com/v1' }));

    expect(dialect.responses).toBe(true);
    expect(dialect.modelCatalogue).toBe(true);
    expect(dialect.containers).toBe(true);
    expect(dialect.documentInput.pdf).toBe('native');
    expect(dialect.chatPayload.maxTokens).toBe('max_completion_tokens');
    expect(dialect.chatPayload.sendSafetyIdentifier).toBe(true);
    expect(dialect.chatPayload.strictRetry).toBe(false);
  });

  it('narrows a compatible OpenAI endpoint to chat-only defaults', () => {
    const dialect = resolveDialect(provider({ baseUrl: 'https://llm.internal.example/v1' }));

    expect(dialect.responses).toBe(false);
    expect(dialect.modelCatalogue).toBe(false);
    expect(dialect.healthProbe).toBe('chat');
    expect(dialect.files).toEqual({ download: false, delete: false });
    expect(dialect.containers).toBe(false);
    expect(dialect.serverCompaction).toBe(false);
    expect(dialect.documentInput.pdf).toBe('text');
    expect(dialect.chatPayload.maxTokens).toBe('max_tokens');
    expect(dialect.chatPayload.sendSafetyIdentifier).toBe(false);
    expect(dialect.chatPayload.strictRetry).toBe(true);
  });

  it('uses the broadly supported Anthropic version for compatible endpoints', () => {
    const dialect = resolveDialect(
      provider({ adapter: 'anthropic', baseUrl: 'https://anthropic.internal.example' }),
    );

    expect(dialect.anthropic?.version).toBe(COMPAT_ANTHROPIC_VERSION);
    expect(dialect.promptCaching).toBe(false);
    expect(dialect.containers).toBe(false);
  });

  it('lets an explicit override widen or narrow the defaults', () => {
    const dialect = resolveDialect(
      provider({
        baseUrl: 'https://llm.internal.example/v1',
        config: {
          dialect: {
            responses: true,
            promptCaching: false,
            documentInput: { pdf: 'native' },
            chatPayload: { maxTokens: 'max_completion_tokens', strictRetry: false },
          },
        },
      }),
    );

    expect(dialect.responses).toBe(true);
    expect(dialect.promptCaching).toBe(false);
    expect(dialect.documentInput.pdf).toBe('native');
    expect(dialect.chatPayload.maxTokens).toBe('max_completion_tokens');
    expect(dialect.chatPayload.strictRetry).toBe(false);
  });

  it('ignores a malformed dialect block instead of throwing', () => {
    const dialect = resolveDialect(
      provider({ config: { dialect: { responses: 'yes', reasoning: 'sometimes' } } }),
    );

    expect(dialect.responses).toBe(true);
    expect(dialect.reasoning).toBe('effort');
  });

  it('honours legacy Anthropic version and beta config', () => {
    const dialect = resolveDialect(
      provider({
        adapter: 'anthropic',
        baseUrl: 'https://anthropic.internal.example',
        config: { anthropicVersion: '2024-01-01', anthropicBeta: ['beta-a'] },
      }),
    );

    expect(dialect.anthropic?.version).toBe('2024-01-01');
    expect(dialect.anthropic?.betas).toEqual(['beta-a']);
  });

  it('prefers the dialect block over legacy Anthropic keys', () => {
    const dialect = resolveDialect(
      provider({
        adapter: 'anthropic',
        baseUrl: 'https://anthropic.internal.example',
        config: {
          anthropicVersion: '2024-01-01',
          dialect: { anthropic: { version: '2025-01-01' } },
        },
      }),
    );

    expect(dialect.anthropic?.version).toBe('2025-01-01');
  });

  it('reports no reasoning control for an unknown adapter', () => {
    const dialect = resolveDialect(provider({ adapter: 'custom' }));

    expect(dialect.reasoning).toBe('none');
    expect(dialect.responses).toBe(false);
  });
});

describe('validateCapabilitiesForDialect', () => {
  const compat = resolveDialect(provider({ baseUrl: 'https://llm.internal.example/v1' }));

  it('accepts capabilities the dialect can serve', () => {
    expect(
      validateCapabilitiesForDialect(
        {
          documentGeneration: false,
          imageGeneration: { mode: 'provider' },
          documents: { pdf: false },
          reasoning: { availableEfforts: ['low'], defaultEffort: 'low' },
        },
        compat,
      ),
    ).toEqual([]);
  });

  it('rejects features the dialect cannot serve', () => {
    const violations = validateCapabilitiesForDialect(
      {
        documentGeneration: true,
        compaction: { triggerTokens: 1000 },
        promptCaching: { supported: true },
        reasoning: { availableEfforts: ['low'], defaultEffort: 'low' },
        imageGeneration: { mode: 'tool' },
        documents: { pdf: true },
      },
      compat,
    );

    expect(violations.map((violation) => violation.field)).toEqual([
      'documentGeneration',
      'compaction',
      'promptCaching',
      'imageGeneration',
      'documents.pdf',
    ]);
  });

  it('rejects reasoning when the provider has no reasoning controls', () => {
    const violations = validateCapabilitiesForDialect(
      { reasoning: { availableEfforts: ['low'], defaultEffort: 'low' } },
      resolveDialect({ adapter: 'gemini', config: {} }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe('reasoning');
  });
});

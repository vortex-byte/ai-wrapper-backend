import type {
  ModelRuntimeConfig,
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent, TokenUsage } from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  HealthCheckResult,
  ProviderAdapter,
} from '@/providers/ports/provider-adapter.ts';

/**
 * Deterministic in-memory adapter used by tests and by `ROLE=all` dev runs.
 * It performs **no network I/O** and supports fault injection so the
 * orchestrator's error/cancel/timeout paths can be exercised without a real provider.
 */

export type FakeScenario =
  | 'success'
  | 'error_before_output'
  | 'error_after_output'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'content_filtered'
  | 'timeout';

export interface FakeProviderOptions {
  readonly adapterKey?: string;
  readonly scenario?: FakeScenario;
  readonly chunks?: readonly string[];
  readonly chunkDelayMs?: number;
  readonly usage?: Partial<TokenUsage>;
  readonly providerRequestId?: string;
}

const DEFAULT_CHUNKS: readonly string[] = ['Hello', ' from', ' the', ' fake', ' provider.'];

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeProvider implements ProviderAdapter {
  readonly adapterKey: string;

  private readonly scenario: FakeScenario;
  private readonly chunks: readonly string[];
  private readonly chunkDelayMs: number;
  private readonly usageOverride: Partial<TokenUsage>;
  private readonly providerRequestId: string;

  constructor(options: FakeProviderOptions = {}) {
    this.adapterKey = options.adapterKey ?? 'fake';
    this.scenario = options.scenario ?? 'success';
    this.chunks = options.chunks ?? DEFAULT_CHUNKS;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.usageOverride = options.usage ?? {};
    this.providerRequestId = options.providerRequestId ?? 'fake-request-1';
  }

  toProviderRequest(req: NormalizedChatRequest): unknown {
    return {
      model: req.model.apiModelId,
      system: req.system ?? null,
      maxOutputTokens: req.maxOutputTokens,
      temperature: req.temperature ?? null,
      topP: req.topP ?? null,
      messages: req.messages.map((message) => ({
        role: message.role,
        parts: message.parts.map((part) => part.type),
      })),
    };
  }

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    const textLength = req.messages.reduce(
      (total, message) =>
        total +
        message.parts.reduce((partTotal, part) => {
          if (part.type === 'text') return partTotal + part.text.length;
          return partTotal + 256;
        }, 0),
      0,
    );
    return { tokens: Math.ceil(textLength / 4) + 8, confidence: 'approx' };
  }

  async *execute(
    req: NormalizedChatRequest,
    ctx: ExecuteContext,
  ): AsyncIterable<GenerationEvent> {
    if (ctx.signal.aborted) {
      yield { type: 'error', error: this.translateError(new Error('aborted')) };
      return;
    }

    if (this.scenario === 'timeout') {
      try {
        await delay(60_000, ctx.signal);
      } catch {
      }
      
      yield { type: 'error', error: this.timeoutError() };
      return;
    }

    if (this.scenario === 'error_before_output' || this.scenario === 'provider_rate_limited') {
      yield { type: 'error', error: this.errorForScenario() };
      return;
    }

    yield {
      type: 'started',
      ...(this.providerRequestId !== '' ? { providerRequestId: this.providerRequestId } : {}),
    };
    yield { type: 'part_started', index: 0, partType: 'text' };

    let outputChars = 0;
    for (const chunk of this.chunks) {
      try {
        await delay(this.chunkDelayMs, ctx.signal);
      } catch {
        yield { type: 'error', error: this.translateError(new Error('aborted')) };
        return;
      }
      if (ctx.signal.aborted) {
        yield { type: 'error', error: this.translateError(new Error('aborted')) };
        return;
      }
      outputChars += chunk.length;
      yield { type: 'text_delta', index: 0, text: chunk };
    }

    if (this.scenario === 'error_after_output') {
      yield { type: 'error', error: this.errorForScenario() };
      return;
    }

    yield { type: 'part_done', index: 0 };
    yield { type: 'usage', usage: this.usageFor(req, outputChars), final: true };

    if (this.scenario === 'content_filtered') {
      yield { type: 'finished', reason: 'content_filter' };
      return;
    }

    yield { type: 'finished', reason: 'stop' };
  }

  translateError(err: unknown): ProviderError {
    if (err instanceof Error && err.message === 'aborted') {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }
    return providerError('provider_unavailable', 'The model provider is unavailable.', {
      retryable: true,
      internalMessage: err instanceof Error ? err.message : String(err),
    });
  }

  async healthCheck(_ctx: { signal: AbortSignal }): Promise<HealthCheckResult> {
    return { ok: this.scenario !== 'provider_unavailable', latencyMs: 0, detail: this.scenario };
  }

  /** The full answer text this run would produce — handy for test assertions. */
  expectedText(): string {
    return this.chunks.join('');
  }

  private errorForScenario(): ProviderError {
    switch (this.scenario) {
      case 'provider_rate_limited':
        return providerError('provider_rate_limited', 'The model provider is throttling requests.', {
          retryable: true,
          retryAfterMs: 1_000,
          providerStatus: 429,
        });
      case 'content_filtered':
        return providerError('content_filtered', 'The response was blocked by a safety filter.', {
          retryable: false,
        });
      case 'error_after_output':
        return providerError('provider_unavailable', 'The model provider is unavailable.', {
          retryable: true,
          providerStatus: 503,
        });
      case 'error_before_output':
        return providerError('provider_unavailable', 'The model provider is unavailable.', {
          retryable: true,
        });
      default:
        return providerError('internal_error', 'An internal error occurred.');
    }
  }

  private timeoutError(): ProviderError {
    return providerError('generation_timeout', 'The model provider did not finish in time.', {
      retryable: true,
    });
  }

  private usageFor(req: NormalizedChatRequest, outputChars: number): TokenUsage {
    const estimatedInput = req.messages.reduce((total, message) => {
      return (
        total +
        message.parts.reduce((partTotal, part) => {
          if (part.type === 'text') return partTotal + part.text.length;
          return partTotal + 256;
        }, 0)
      );
    }, 0);
    return {
      inputTokens: this.usageOverride.inputTokens ?? Math.ceil(estimatedInput / 4) + 8,
      outputTokens: this.usageOverride.outputTokens ?? Math.ceil(outputChars / 4),
      ...(this.usageOverride.cachedInputTokens !== undefined
        ? { cachedInputTokens: this.usageOverride.cachedInputTokens }
        : {}),
      ...(this.usageOverride.reasoningTokens !== undefined
        ? { reasoningTokens: this.usageOverride.reasoningTokens }
        : {}),
      source: this.usageOverride.source ?? 'provider',
    };
  }
}

/** Convenience factory used by tests to build a request double. */
export function makeChatRequest(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  const model: ModelRuntimeConfig = {
    modelId: 'model-1',
    providerId: 'provider-1',
    apiModelId: 'fake-model',
    displayName: 'Fake Model',
    capabilities: {
      streaming: true,
      vision: false,
      documents: { pdf: false },
      imageGeneration: false,
      documentGeneration: false,
      systemPrompt: true,
      tools: false,
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
    },
    maxOutputTokens: 1_024,
    defaultMaxOutputTokens: 1_024,
    quotaWeight: 1,
    config: {},
  };
  const provider: ProviderRuntimeConfig = {
    providerId: 'provider-1',
    key: 'fake',
    adapter: 'fake',
    config: {},
    secrets: {},
  };
  return {
    requestId: 'req-1',
    generationId: 'gen-1',
    model,
    provider,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello there' }] }],
    maxOutputTokens: 1_024,
    responseModalities: ['text'],
    metadata: { userIdHash: 'hash-1' },
    ...overrides,
  };
}

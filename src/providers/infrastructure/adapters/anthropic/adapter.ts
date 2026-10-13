import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedChatRequest, ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  HealthCheckContext,
  HealthCheckResult,
  ProviderAdapter,
} from '@/providers/ports/provider-adapter.ts';
import {
  approximateEstimate,
  healthFailed,
  healthNotConfigured,
  numberFromConfig,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface AnthropicClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  messages: {
    create(
      params: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<unknown>>;
  };
}

export type AnthropicClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}) => AnthropicClientLike;

const defaultFactory: AnthropicClientFactory = (options) =>
  new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

interface RawAnthropicStreamEvent {
  readonly type: string;
  readonly message?: {
    readonly id?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    };
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly stop_reason?: string | null;
  };
  readonly usage?: {
    readonly output_tokens?: number;
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly adapterKey = 'anthropic';

  constructor(private readonly clientFactory: AnthropicClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest): unknown {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const message of req.messages) {
      const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('');

      const last = messages[messages.length - 1];
      if (last && last.role === message.role) {
        last.content = last.content.length > 0 && text.length > 0 ? `${last.content}\n\n${text}` : `${last.content}${text}`;
      } else {
        messages.push({ role: message.role as 'user' | 'assistant', content: text });
      }
    }

    return {
      model: req.model.apiModelId,
      max_tokens: req.maxOutputTokens,
      ...(req.system && req.system.trim().length > 0 ? { system: req.system } : {}),
      messages,
      stream: true,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    };
  }

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    const textLength = req.messages.reduce(
      (total, message) =>
        total +
        message.parts.reduce(
          (partTotal, part) => (part.type === 'text' ? partTotal + part.text.length : partTotal + 256),
          0,
        ),
      req.system ? req.system.length : 0,
    );
    return approximateEstimate(textLength);
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'Anthropic API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const client = this.buildClient(req.provider, apiKey);
    const params = this.toProviderRequest(req);

    let stream: AsyncIterable<unknown>;
    try {
      stream = await client.messages.create(params, { signal: ctx.signal });
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    let started = false;
    let partStarted = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let terminalReason: FinishReason = 'stop';

    try {
      for await (const rawEvent of stream) {
        const ev = rawEvent as RawAnthropicStreamEvent;

        if (ev.type === 'message_start') {
          if (!started) {
            started = true;
            yield {
              type: 'started',
              ...(ev.message?.id ? { providerRequestId: ev.message.id } : {}),
            };
            partStarted = true;
            yield { type: 'part_started', index: 0, partType: 'text' };
          }
          if (ev.message?.usage?.input_tokens !== undefined) {
            inputTokens = ev.message.usage.input_tokens;
          }
          if (ev.message?.usage?.cache_read_input_tokens !== undefined) {
            cachedInputTokens = ev.message.usage.cache_read_input_tokens;
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.text) {
            yield { type: 'text_delta', index: 0, text: ev.delta.text };
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) {
            terminalReason = this.mapFinishReason(ev.delta.stop_reason);
          }
          if (ev.usage?.output_tokens !== undefined) {
            outputTokens = ev.usage.output_tokens;
          }
        }
      }

      if (partStarted) {
        yield { type: 'part_done', index: 0 };
      }

      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          source: 'provider',
        },
        final: true,
      };

      yield { type: 'finished', reason: terminalReason };
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
    }
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      default:
        return 'other';
    }
  }

  translateError(err: unknown): ProviderError {
    if (err instanceof Anthropic.APIError) {
      const status = err.status;
      const rawMsg = err.message ?? '';
      const sanitized = scrubSecrets(rawMsg);

      let retryAfterMs: number | undefined;
      const headers = err.headers;
      if (headers) {
        const headerVal =
          typeof (headers as { get?: (k: string) => string | null }).get === 'function'
            ? (headers as { get: (k: string) => string | null }).get('retry-after')
            : (headers as Record<string, string>)['retry-after'];
        retryAfterMs = parseRetryAfter(headerVal);
      }

      if (status === 400) {
        const isContext =
          rawMsg.includes('prompt is too long') ||
          rawMsg.includes('max_tokens') ||
          rawMsg.includes('context window');
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext
            ? 'The conversation exceeds the model context window.'
            : 'The model provider rejected the request.',
          { retryable: false, internalMessage: sanitized },
        );
      }

      if (status === 401 || status === 403) {
        return providerError('provider_unavailable', 'The model provider rejected authentication.', {
          retryable: false,
          internalMessage: sanitized,
        });
      }

      if (status === 404) {
        return providerError('model_unavailable', 'The requested model is not available from the provider.', {
          retryable: false,
          internalMessage: sanitized,
        });
      }

      if (status === 429) {
        return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
        });
      }

      if (status >= 500) {
        return providerError('provider_unavailable', 'The model provider is temporarily unavailable.', {
          retryable: true,
          internalMessage: sanitized,
        });
      }
    }

    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';

    if (errName === 'AbortError' || errMsg.includes('aborted')) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    if (errName === 'TimeoutError' || errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')) {
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    return providerError('provider_unavailable', 'The model provider is unavailable.', {
      retryable: true,
      internalMessage: errMsg,
    });
  }

  async healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    const { provider, signal } = ctx;
    const apiKey = provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      return healthNotConfigured('secret_not_configured');
    }
    const startedAt = Date.now();
    try {
      const client = this.buildClient(provider, apiKey);
      const result = await client.models.list(undefined, { signal });
      return { ok: true, latencyMs: Date.now() - startedAt, detail: `models.list ok (${result.data.length})` };
    } catch (error) {
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  private buildClient(provider: ProviderRuntimeConfig, apiKey: string): AnthropicClientLike {
    return this.clientFactory({
      apiKey,
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
      maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    });
  }
}

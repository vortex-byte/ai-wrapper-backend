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
  healthFailed,
  healthNotConfigured,
  isAbortLikeError,
  isTimeoutLikeError,
  numberFromConfig,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';
import { estimateClaudeInputTokens } from './tokenizer/claude-tokenizer.ts';

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
  readonly index?: number;
  readonly message?: {
    readonly id?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    };
  };
  readonly content_block?: {
    readonly type?: string;
    readonly text?: string;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly stop_reason?: string | null;
  };
  readonly usage?: {
    readonly output_tokens?: number;
  };
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
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

      const content = text.length > 0 ? text : ' ';

      const last = messages[messages.length - 1];
      if (last && last.role === message.role) {
        last.content = `${last.content}\n\n${content}`;
      } else {
        messages.push({ role: message.role as 'user' | 'assistant', content });
      }
    }

    if (messages.length === 0) {
      messages.push({ role: 'user', content: ' ' });
    } else if (messages[0]?.role === 'assistant') {
      messages.unshift({ role: 'user', content: ' ' });
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
    return estimateClaudeInputTokens({
      ...(req.system !== undefined ? { system: req.system } : {}),
      messages: req.messages.map((message) => ({
        parts: message.parts.map((part) =>
          part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type },
        ),
      })),
    });
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
    const openBlocks = new Set<number>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let terminalReason: FinishReason = 'stop';

    try {
      for await (const rawEvent of stream) {
        const ev = rawEvent as RawAnthropicStreamEvent;

        if (ev.type === 'error') {
          yield { type: 'error', error: this.translateError(ev.error ?? ev) };
          return;
        }

        if (ev.type === 'message_start') {
          if (!started) {
            started = true;
            yield {
              type: 'started',
              ...(ev.message?.id ? { providerRequestId: ev.message.id } : {}),
            };
          }
          const uncached = ev.message?.usage?.input_tokens ?? 0;
          const cacheRead = ev.message?.usage?.cache_read_input_tokens ?? 0;
          const cacheCreation = ev.message?.usage?.cache_creation_input_tokens ?? 0;
          inputTokens = uncached + cacheRead + cacheCreation;
          if (cacheRead > 0) {
            cachedInputTokens = cacheRead;
          }
        } else if (ev.type === 'content_block_start') {
          if (!started) {
            started = true;
            yield { type: 'started' };
          }
          const index = ev.index ?? 0;
          openBlocks.add(index);
          yield { type: 'part_started', index, partType: 'text' };
        } else if (ev.type === 'content_block_delta') {
          if (!started) {
            started = true;
            yield { type: 'started' };
          }
          const index = ev.index ?? 0;
          if (!openBlocks.has(index)) {
            openBlocks.add(index);
            yield { type: 'part_started', index, partType: 'text' };
          }
          if (ev.delta?.text) {
            yield { type: 'text_delta', index, text: ev.delta.text };
          }
        } else if (ev.type === 'content_block_stop') {
          const index = ev.index ?? 0;
          if (openBlocks.has(index)) {
            openBlocks.delete(index);
            yield { type: 'part_done', index };
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

      if (!started) {
        yield { type: 'started' };
      }

      for (const index of openBlocks) {
        yield { type: 'part_done', index };
      }
      openBlocks.clear();

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
      case 'model_context_window_exceeded':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      case 'refusal':
        return 'content_filter';
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

      const errType = (err as { error?: { type?: string } }).error?.type;

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
          {
            retryable: false,
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 401 || status === 403) {
        return providerError('provider_unavailable', 'The model provider rejected authentication.', {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 404) {
        return providerError('model_unavailable', 'The requested model is not available from the provider.', {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 413) {
        return providerError('context_too_large', 'The request exceeds the provider size limits.', {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 408) {
        return providerError('generation_timeout', 'The model provider timed out.', {
          retryable: true,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 429) {
        return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 529 || errType === 'overloaded_error') {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          providerCode: errType ?? 'overloaded_error',
        });
      }

      if (status >= 500) {
        return providerError('provider_unavailable', 'The model provider is temporarily unavailable.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }
    }

    if (typeof err === 'object' && err !== null) {
      const maybeErr = err as {
        type?: string;
        message?: string;
        error?: { type?: string; message?: string };
        status?: number;
      };
      const errType = maybeErr.error?.type ?? maybeErr.type;
      const rawMsg = maybeErr.error?.message ?? maybeErr.message ?? '';
      const sanitized = scrubSecrets(rawMsg);

      if (errType === 'overloaded_error' || maybeErr.status === 529) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          internalMessage: sanitized,
          providerCode: 'overloaded_error',
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        });
      }

      if (errType === 'rate_limit_error') {
        return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
          retryable: true,
          internalMessage: sanitized,
          providerCode: errType,
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        });
      }

      if (errType === 'invalid_request_error') {
        return providerError('invalid_request', 'The model provider rejected the request.', {
          retryable: false,
          internalMessage: sanitized,
          providerCode: errType,
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        });
      }
    }

    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';

    if (isAbortLikeError(err, [Anthropic.APIUserAbortError])) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    if (isTimeoutLikeError(err, [Anthropic.APIConnectionTimeoutError])) {
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

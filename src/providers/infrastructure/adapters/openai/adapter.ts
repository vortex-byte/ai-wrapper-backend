import OpenAI from 'openai';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
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

let o200kEncoding: Tiktoken | null = null;
let cl100kEncoding: Tiktoken | null = null;

function getTiktoken(modelId: string): Tiktoken | null {
  try {
    if (modelId.startsWith('gpt-4o') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
      if (!o200kEncoding) o200kEncoding = getEncoding('o200k_base');
      return o200kEncoding;
    }
    if (!cl100kEncoding) cl100kEncoding = getEncoding('cl100k_base');
    return cl100kEncoding;
  } catch {
    return null;
  }
}

export interface OpenAIClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  chat: {
    completions: {
      create(
        params: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<unknown>>;
    };
  };
}

export type OpenAIClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}) => OpenAIClientLike;

const defaultFactory: OpenAIClientFactory = (options) =>
  new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

interface RawOpenAIChunk {
  readonly id?: string;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly role?: string;
    };
    readonly finish_reason?: string | null;
    readonly index?: number;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens?: number;
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: number;
    };
    readonly completion_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
  } | null;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly adapterKey = 'openai';

  constructor(private readonly clientFactory: OpenAIClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (req.system && req.system.trim().length > 0) {
      messages.push({ role: 'system', content: req.system });
    }

    for (const msg of req.messages) {
      const text = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('');
      messages.push({ role: msg.role, content: text });
    }

    return {
      model: req.model.apiModelId,
      messages,
      max_completion_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    };
  }

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    const enc = getTiktoken(req.model.apiModelId);
    if (!enc) {
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

    let tokens = 0;
    if (req.system) {
      tokens += enc.encode(req.system).length + 4;
    }
    for (const msg of req.messages) {
      tokens += 3; // formatting overhead per message
      for (const part of msg.parts) {
        if (part.type === 'text') {
          tokens += enc.encode(part.text).length;
        } else {
          tokens += 256;
        }
      }
    }
    tokens += 3; // assistant reply priming

    return { tokens, confidence: 'exact' };
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'OpenAI API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const client = this.buildClient(req.provider, apiKey);
    const params = this.toProviderRequest(req);

    let stream: AsyncIterable<unknown>;
    try {
      stream = await client.chat.completions.create(params, { signal: ctx.signal });
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    let started = false;
    let partStarted = false;
    let terminalReason: FinishReason = 'stop';

    try {
      for await (const rawChunk of stream) {
        const chunk = rawChunk as RawOpenAIChunk;

        if (!started) {
          started = true;
          yield {
            type: 'started',
            ...(chunk.id ? { providerRequestId: chunk.id } : {}),
          };
          partStarted = true;
          yield { type: 'part_started', index: 0, partType: 'text' };
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          yield { type: 'text_delta', index: 0, text: choice.delta.content };
        }

        if (choice?.finish_reason) {
          terminalReason = this.mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
              reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              source: 'provider',
            },
            final: true,
          };
        }
      }

      if (partStarted) {
        yield { type: 'part_done', index: 0 };
      }
      yield { type: 'finished', reason: terminalReason };
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
    }
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  translateError(err: unknown): ProviderError {
    if (err instanceof OpenAI.APIError) {
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
        const isContext = rawMsg.includes('context_length_exceeded') || rawMsg.includes('maximum context length');
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext ? 'The conversation exceeds the model context window.' : 'The model provider rejected the request.',
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

  private buildClient(provider: ProviderRuntimeConfig, apiKey: string): OpenAIClientLike {
    return this.clientFactory({
      apiKey,
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
      maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    });
  }
}

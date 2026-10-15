import OpenAI from 'openai';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
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
  HealthCheckContext,
  HealthCheckResult,
  ProviderAdapter,
} from '@/providers/ports/provider-adapter.ts';
import {
  approximateEstimate,
  healthFailed,
  healthNotConfigured,
  isAbortLikeError,
  isTimeoutLikeError,
  numberFromConfig,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

let o200kEncoding: Tiktoken | null = null;
let cl100kEncoding: Tiktoken | null = null;

/** o200k_base covers current OpenAI model families; cl100k_base is legacy (gpt-3.5/gpt-4). */
export function getTiktoken(modelId: string): Tiktoken | null {
  try {
    const lower = modelId.toLowerCase();
    const o200kPrefixes = [
      'gpt-4o',
      'gpt-4.1',
      'gpt-5',
      'gpt-6',
      'o1',
      'o2',
      'o3',
      'o4',
      'chatgpt-4o',
    ];
    if (o200kPrefixes.some((prefix) => lower.startsWith(prefix))) {
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
      readonly refusal?: string | null;
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

/** Shared metadata attached to every translated OpenAI error. */
interface TranslatedMeta {
  readonly internalMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
}

/** Codes that mean "billing/quota action required" — never retried (docs: rate-limits guide). */
const BILLING_429_CODES: ReadonlySet<string> = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
]);

/** Minimal structural view of an SDK APIError body for code/type reads. */
interface ApiErrorShape {
  readonly code?: unknown;
  readonly type?: unknown;
  readonly error?: unknown;
}

/**
 * Read the structured `code`/`type` from an APIError body. The SDK unwraps the
 * response envelope (`{error: {...}}`) for real calls, but direct constructor
 * use keeps the envelope — accept both shapes.
 */
function readBodyField(err: ApiErrorShape, field: 'code' | 'type'): string | undefined {
  const direct = err[field];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const body = err.error;
  const nested = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  for (const candidate of [body, nested]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const value = (candidate as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Reasoning models reject `temperature`/`top_p` when reasoning is active
 * (docs: latest-model guide). Explicit registry config wins; fall back to the
 * model-family prefix so a misconfigured registry still fails safe-ish.
 */
function supportsSamplingParams(model: ModelRuntimeConfig): boolean {
  const override = model.config['supportsSamplingParams'];
  if (typeof override === 'boolean') return override;
  const effort = model.config['reasoningEffort'];
  if (typeof effort === 'string' && effort !== 'none') return false;
  return !/^(o[0-9]|gpt-[56])/.test(model.apiModelId);
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

      const content = text.length > 0 ? text : ' ';

      const last = messages[messages.length - 1];
      if (last && last.role === msg.role) {
        last.content = `${last.content}\n\n${content}`;
      } else {
        messages.push({ role: msg.role, content });
      }
    }

    if (messages.length === 0) {
      messages.push({ role: 'user', content: ' ' });
    }

    const sampling = supportsSamplingParams(req.model);

    return {
      model: req.model.apiModelId,
      messages,
      max_completion_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(sampling && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
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
      tokens += 3;
      for (const part of msg.parts) {
        if (part.type === 'text') {
          tokens += enc.encode(part.text).length;
        } else {
          tokens += 256;
        }
      }
    }
    tokens += 3;

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
    let pendingUsage: TokenUsage | undefined;
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
        }

        const choice = chunk.choices?.[0];
        const refusalText = choice?.delta?.refusal;
        const contentText = choice?.delta?.content;
        if (refusalText || contentText) {
          if (!partStarted) {
            partStarted = true;
            yield { type: 'part_started', index: 0, partType: 'text' };
          }
          if (refusalText) {
            yield { type: 'text_delta', index: 0, text: refusalText };
          }
          if (contentText) {
            yield { type: 'text_delta', index: 0, text: contentText };
          }
        }

        if (choice?.finish_reason) {
          terminalReason = this.mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          pendingUsage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            source: 'provider',
          };
        }
      }

      if (!started) {
        yield { type: 'started' };
      }
      if (partStarted) {
        yield { type: 'part_done', index: 0 };
      }
      if (pendingUsage) {
        yield { type: 'usage', usage: pendingUsage, final: true };
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
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'other';
    }
  }

  translateError(err: unknown): ProviderError {
    if (isAbortLikeError(err, [OpenAI.APIUserAbortError])) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    if (isTimeoutLikeError(err, [OpenAI.APIConnectionTimeoutError])) {
      const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      const rawMsg = err.message ?? '';
      const sanitized = scrubSecrets(rawMsg);
      const errCode = readBodyField(err, 'code');
      const errType = readBodyField(err, 'type');

      let retryAfterMs: number | undefined;
      const headers = err.headers;
      if (headers) {
        const headerVal =
          typeof (headers as { get?: (k: string) => string | null }).get === 'function'
            ? (headers as { get: (k: string) => string | null }).get('retry-after')
            : (headers as Record<string, string>)['retry-after'];
        retryAfterMs = parseRetryAfter(headerVal);
      }

      const withMeta = (extra: Omit<TranslatedMeta, 'internalMessage'> = {}): TranslatedMeta => ({
        internalMessage: sanitized,
        ...(status !== undefined ? { providerStatus: status } : {}),
        ...(errCode !== undefined ? { providerCode: errCode } : {}),
        ...(err.requestID ? { providerRequestId: err.requestID } : {}),
        ...extra,
      });

      if (status === 400) {
        const isContext =
          errCode === 'context_length_exceeded' ||
          rawMsg.includes('context_length_exceeded') ||
          rawMsg.includes('maximum context length');
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext
            ? 'The conversation exceeds the model context window.'
            : 'The model provider rejected the request.',
          { retryable: false, ...withMeta() },
        );
      }

      if (status === 401 || status === 403) {
        return providerError('provider_unavailable', 'The model provider rejected authentication.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 404) {
        return providerError('model_unavailable', 'The requested model is not available from the provider.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 408) {
        return providerError('generation_timeout', 'The model provider timed out.', {
          retryable: true,
          ...withMeta(),
        });
      }

      if (status === 410) {
        return providerError('model_unavailable', 'The requested model is no longer available from the provider.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 413) {
        return providerError('context_too_large', 'The request exceeds the provider size limits.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 422 || status === 451) {
        return providerError('content_filtered', 'The request was rejected by the provider content policy.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 429) {
        if ((errCode !== undefined && BILLING_429_CODES.has(errCode)) || errType === 'insufficient_quota') {
          return providerError(
            'provider_unavailable',
            'The model provider reported a billing or usage limit; add credits or raise the limit.',
            { retryable: false, ...withMeta() },
          );
        }
        return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...withMeta(),
        });
      }

      if (status === 503 && (errCode === 'server_is_overloaded' || errType === 'service_unavailable_error')) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...withMeta(),
        });
      }

      if (status !== undefined && status >= 500) {
        return providerError('provider_unavailable', 'The model provider is temporarily unavailable.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...withMeta(),
        });
      }

      // Any other 4xx is a client-side rejection: never retry blindly.
      if (status !== undefined && status >= 400 && status < 500) {
        return providerError('provider_unavailable', 'The model provider rejected the request.', {
          retryable: false,
          ...withMeta(),
        });
      }

      // APIError without an HTTP status: mid-stream throws, connection failures.
      // Branch on the structured type/code the SDK extracted from the error body.
      if (status === undefined) {
        const retryOpts = retryAfterMs !== undefined ? { retryAfterMs } : {};
        if (errType === 'rate_limit_error') {
          return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
            retryable: true,
            ...retryOpts,
            ...withMeta(),
          });
        }
        if (
          errType === 'service_unavailable_error' ||
          errCode === 'server_is_overloaded' ||
          errType === 'overloaded_error' ||
          errCode === 'overloaded_error'
        ) {
          return providerError('service_busy', 'The model provider is temporarily overloaded.', {
            retryable: true,
            ...retryOpts,
            ...withMeta({ providerCode: errCode ?? errType ?? 'overloaded_error' }),
          });
        }
        if (errType === 'invalid_request_error') {
          return providerError('invalid_request', 'The model provider rejected the request.', {
            retryable: false,
            ...withMeta(),
          });
        }
        if (errCode === 'context_length_exceeded') {
          return providerError('context_too_large', 'The conversation exceeds the model context window.', {
            retryable: false,
            ...withMeta(),
          });
        }
      }
    }

    if (err instanceof OpenAI.APIConnectionError) {
      const errMsg = scrubSecrets(err.message);
      return providerError('provider_unavailable', 'The model provider is unavailable.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    if (!(err instanceof OpenAI.APIError) && typeof err === 'object' && err !== null) {
      const maybeErr = err as {
        type?: string;
        code?: string;
        message?: string;
        status?: number;
        error?: { type?: string; code?: string; message?: string };
      };
      const errType = maybeErr.error?.type ?? maybeErr.type;
      const errCode = maybeErr.error?.code ?? maybeErr.code;
      const rawMsg = maybeErr.error?.message ?? maybeErr.message ?? '';
      const sanitized = scrubSecrets(rawMsg);
      const meta = {
        internalMessage: sanitized,
        ...(maybeErr.status !== undefined ? { providerStatus: maybeErr.status } : {}),
        ...(errCode !== undefined
          ? { providerCode: errCode }
          : errType !== undefined
            ? { providerCode: errType }
            : {}),
      };

      if (
        errType === 'overloaded_error' ||
        errType === 'service_unavailable_error' ||
        errCode === 'server_is_overloaded' ||
        errCode === 'overloaded_error' ||
        maybeErr.status === 503
      ) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...meta,
        });
      }

      if (errType === 'rate_limit_error' || errCode === 'rate_limit_exceeded') {
        return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
          retryable: true,
          ...meta,
        });
      }

      if (errType === 'invalid_request_error') {
        return providerError('invalid_request', 'The model provider rejected the request.', {
          retryable: false,
          ...meta,
        });
      }

      if (errCode === 'context_length_exceeded') {
        return providerError('context_too_large', 'The conversation exceeds the model context window.', {
          retryable: false,
          ...meta,
        });
      }
    }

    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
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

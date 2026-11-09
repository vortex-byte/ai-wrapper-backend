import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import {
  isAbortLikeError,
  isTimeoutLikeError,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';
import type {
  GeminiErrorShape,
  GeminiResponseLike,
  TranslatedMeta,
} from './types.ts';

export function translateError(err: unknown): ProviderError {
  if (isAbortLikeError(err)) {
    return providerError('generation_cancelled', 'The generation was cancelled.', {
      retryable: false,
    });
  }

  const shape: GeminiErrorShape = typeof err === 'object' && err !== null ? err : {};
  const inner = shape.error;
  const message = inner?.message ?? shape.message ?? (err instanceof Error ? err.message : '');
  const sanitized = scrubSecrets(message);
  const status =
    typeof shape.status === 'number'
      ? shape.status
      : typeof inner?.code === 'number'
        ? inner.code
        : undefined;
  const statusName = inner?.status ?? shape.statusText;
  const retryAfterMs = shape.retryAfterMs;

  if (
    isTimeoutLikeError(err) ||
    status === 408 ||
    status === 504 ||
    statusName === 'DEADLINE_EXCEEDED'
  ) {
    return providerError('generation_timeout', 'The model provider timed out.', {
      retryable: true,
      ...(status !== undefined ? { providerStatus: status } : {}),
      internalMessage: sanitized,
    });
  }

  if (status !== undefined || statusName !== undefined) {
    const withMeta = (extra: Omit<TranslatedMeta, 'internalMessage'> = {}): TranslatedMeta => ({
      internalMessage: sanitized,
      ...(status !== undefined ? { providerStatus: status } : {}),
      ...(statusName !== undefined ? { providerCode: statusName } : {}),
      ...extra,
    });
    const retryOpts = retryAfterMs !== undefined ? { retryAfterMs } : {};

    if (status === 400) {
      const isContext = /context|token|too large|maximum/i.test(message);
      return providerError(
        isContext ? 'context_too_large' : 'invalid_request',
        isContext
          ? 'The conversation exceeds the model context window.'
          : 'The model provider rejected the request.',
        { retryable: false, ...withMeta() },
      );
    }

    if (
      status === 401 ||
      status === 403 ||
      statusName === 'UNAUTHENTICATED' ||
      statusName === 'PERMISSION_DENIED'
    ) {
      return providerError(
        'provider_unavailable',
        'The model provider rejected authentication.',
        {
          retryable: false,
          ...withMeta(),
        },
      );
    }

    if (status === 404 || statusName === 'NOT_FOUND') {
      return providerError(
        'model_unavailable',
        'The requested model is not available from the provider.',
        {
          retryable: false,
          ...withMeta(),
        },
      );
    }

    if (status === 413) {
      return providerError('context_too_large', 'The request exceeds the provider size limits.', {
        retryable: false,
        ...withMeta(),
      });
    }

    if (status === 429 || statusName === 'RESOURCE_EXHAUSTED') {
      return providerError(
        'provider_rate_limited',
        'The model provider is rate limiting requests.',
        {
          retryable: true,
          ...retryOpts,
          ...withMeta(),
        },
      );
    }

    if (status !== undefined && status >= 500) {
      return providerError(
        'provider_unavailable',
        'The model provider is temporarily unavailable.',
        {
          retryable: true,
          ...retryOpts,
          ...withMeta(),
        },
      );
    }

    if (status !== undefined && status >= 400) {
      return providerError('provider_unavailable', 'The model provider rejected the request.', {
        retryable: false,
        ...withMeta(),
      });
    }

    if (statusName === 'INVALID_ARGUMENT') {
      return providerError('invalid_request', 'The model provider rejected the request.', {
        retryable: false,
        ...withMeta(),
      });
    }
    if (statusName === 'UNAVAILABLE' || statusName === 'INTERNAL') {
      return providerError(
        'provider_unavailable',
        'The model provider is temporarily unavailable.',
        {
          retryable: true,
          ...retryOpts,
          ...withMeta(),
        },
      );
    }
  }

  const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
  return providerError('provider_unavailable', 'The model provider is unavailable.', {
    retryable: true,
    internalMessage: errMsg,
  });
}

export async function translateResponse(response: GeminiResponseLike): Promise<ProviderError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const inner =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return translateError({
    status: response.status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(inner !== undefined && inner !== null ? { error: inner } : {}),
  });
}

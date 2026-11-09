import Anthropic from '@anthropic-ai/sdk';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import {
  isAbortLikeError,
  isTimeoutLikeError,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';

export function translateError(err: unknown): ProviderError {
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
      return providerError(
        'provider_unavailable',
        'The model provider rejected authentication.',
        {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        },
      );
    }

    if (status === 404) {
      return providerError(
        'model_unavailable',
        'The requested model is not available from the provider.',
        {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        },
      );
    }

    if (status === 413) {
      return providerError('context_too_large', 'The request exceeds the provider size limits.', {
        retryable: false,
        internalMessage: sanitized,
        providerStatus: status,
        ...(errType ? { providerCode: errType } : {}),
      });
    }

    if (status === 402) {
      return providerError(
        'provider_unavailable',
        'The model provider rejected the request for billing reasons.',
        {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        },
      );
    }

    if (status === 408 || status === 504) {
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        internalMessage: sanitized,
        providerStatus: status,
        ...(errType ? { providerCode: errType } : {}),
      });
    }

    if (status === 429) {
      return providerError(
        'provider_rate_limited',
        'The model provider is rate limiting requests.',
        {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        },
      );
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
      return providerError(
        'provider_unavailable',
        'The model provider is temporarily unavailable.',
        {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        },
      );
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
      return providerError(
        'provider_rate_limited',
        'The model provider is rate limiting requests.',
        {
          retryable: true,
          internalMessage: sanitized,
          providerCode: errType,
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        },
      );
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

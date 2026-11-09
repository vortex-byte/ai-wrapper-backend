import OpenAI from 'openai';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import { isAbortLikeError, isTimeoutLikeError, scrubSecrets } from '../shared.ts';
import { BILLING_429_CODES } from './config.ts';
import { parseRetryAfterHeader } from './client.ts';
import type { ApiErrorShape, RawResponsesEvent, TranslatedMeta } from './types.ts';

export function readBodyField(err: ApiErrorShape, field: 'code' | 'type'): string | undefined {
  const direct = err[field];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const body = err.error;
  const nested =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  for (const candidate of [body, nested]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const value = (candidate as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

function translateSdkError(err: InstanceType<typeof OpenAI.APIError>): ProviderError | undefined {
  const status = err.status;
  const rawMsg = err.message ?? '';
  const sanitized = scrubSecrets(rawMsg);
  const errCode = readBodyField(err, 'code');
  const errType = readBodyField(err, 'type');
  const retryAfterMs = parseRetryAfterHeader(err.headers);

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

  if (status === 408 || status === 504) {
    return providerError('generation_timeout', 'The model provider timed out.', {
      retryable: true,
      ...withMeta(),
    });
  }

  if (status === 410) {
    return providerError(
      'model_unavailable',
      'The requested model is no longer available from the provider.',
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

  if (status === 422 || status === 451) {
    return providerError('content_filtered', 'The request was rejected by the provider content policy.', {
      retryable: false,
      ...withMeta(),
    });
  }

  if (status === 429) {
    if (
      (errCode !== undefined && BILLING_429_CODES.has(errCode)) ||
      errType === 'insufficient_quota'
    ) {
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

  if (
    status === 503 &&
    (errCode === 'server_is_overloaded' || errType === 'service_unavailable_error')
  ) {
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

  if (status !== undefined && status >= 400 && status < 500) {
    return providerError('provider_unavailable', 'The model provider rejected the request.', {
      retryable: false,
      ...withMeta(),
    });
  }

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

  return undefined;
}

function translateUnknownStructure(err: object): ProviderError | undefined {
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

  return undefined;
}

export function translateError(err: unknown): ProviderError {
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
    const translated = translateSdkError(err);
    if (translated !== undefined) return translated;
  }

  if (err instanceof OpenAI.APIConnectionError) {
    const errMsg = scrubSecrets(err.message);
    return providerError('provider_unavailable', 'The model provider is unavailable.', {
      retryable: true,
      internalMessage: errMsg,
    });
  }

  if (!(err instanceof OpenAI.APIError) && typeof err === 'object' && err !== null) {
    const translated = translateUnknownStructure(err);
    if (translated !== undefined) return translated;
  }

  const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
  return providerError('provider_unavailable', 'The model provider is unavailable.', {
    retryable: true,
    internalMessage: errMsg,
  });
}

const CONTENT_FILTER_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'moderation_blocked',
  'image_content_policy_violation',
  'bio_policy',
  'misalignment_policy_violation',
]);

const IMAGE_INPUT_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'invalid_image',
  'invalid_image_format',
  'invalid_base64_image',
  'invalid_image_url',
  'image_too_large',
  'image_too_small',
  'image_parse_error',
  'invalid_image_mode',
  'image_file_too_large',
  'unsupported_image_media_type',
  'empty_image_file',
  'failed_to_download_image',
  'image_file_not_found',
]);

const INVALID_REQUEST_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'invalid_prompt',
  'invalid_request_error',
]);

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function responsesError(event: RawResponsesEvent): ProviderError {
  const failure = event.response?.error;
  const message = scrubSecrets(failure?.message ?? event.message ?? 'unknown_error');
  const code = nonEmpty(failure?.code ?? event.code ?? undefined);
  const type = nonEmpty(failure?.type);
  const meta = {
    internalMessage: message,
    ...(code !== undefined ? { providerCode: code } : {}),
    ...(code === undefined && type !== undefined ? { providerCode: type } : {}),
  };

  if (code !== undefined && CONTENT_FILTER_RESPONSE_CODES.has(code)) {
    return providerError('content_filtered', 'The request was rejected by the provider content policy.', {
      retryable: false,
      ...meta,
    });
  }

  if (type === 'image_generation_user_error') {
    return providerError('invalid_request', 'The image request was rejected; adjust the prompt or options.', {
      retryable: false,
      ...meta,
    });
  }

  if (code !== undefined && IMAGE_INPUT_RESPONSE_CODES.has(code)) {
    return providerError('invalid_request', 'The image request was rejected; adjust the image or options.', {
      retryable: false,
      ...meta,
    });
  }

  if (code !== undefined && INVALID_REQUEST_RESPONSE_CODES.has(code)) {
    return providerError('invalid_request', 'The model provider rejected the request.', {
      retryable: false,
      ...meta,
    });
  }

  if (code === 'rate_limit_exceeded') {
    return providerError('provider_rate_limited', 'The model provider is rate limiting requests.', {
      retryable: true,
      ...meta,
    });
  }

  return providerError('provider_unavailable', 'The model provider could not complete the request.', {
    retryable: true,
    ...meta,
  });
}

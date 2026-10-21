/** Normalized provider error vocabulary and translation types. */

export type AppErrorCategory =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'password_change_required'
  | 'not_found'
  | 'conflict'
  | 'generation_in_progress'
  | 'idempotency_key_reuse'
  | 'model_unavailable'
  | 'unsupported_for_model'
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'concurrency_limit'
  | 'context_too_large'
  | 'content_filtered'
  | 'file_too_large'
  | 'unsupported_file_type'
  | 'file_not_ready'
  | 'file_processing_failed'
  | 'generation_timeout'
  | 'generation_cancelled'
  | 'service_busy'
  | 'storage_unavailable'
  | 'internal_error';

export interface ProviderError {
  readonly category: AppErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly safeMessage: string;
  readonly internalMessage?: string;
}

/** Construct a `ProviderError` with only the safe fields a caller usually needs. */
export function providerError(
  category: AppErrorCategory,
  safeMessage: string,
  options: {
    retryable?: boolean;
    retryAfterMs?: number;
    providerStatus?: number;
    providerCode?: string;
    providerRequestId?: string;
    internalMessage?: string;
  } = {},
): ProviderError {
  return {
    category,
    retryable: options.retryable ?? false,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options.providerStatus !== undefined ? { providerStatus: options.providerStatus } : {}),
    ...(options.providerCode !== undefined ? { providerCode: options.providerCode } : {}),
    ...(options.providerRequestId !== undefined
      ? { providerRequestId: options.providerRequestId }
      : {}),
    safeMessage,
    ...(options.internalMessage !== undefined
      ? { internalMessage: options.internalMessage }
      : {}),
  };
}

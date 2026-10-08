/**
 * The error vocabulary of `docs/API_CONTRACTS.md` §14. `code` values are stable and
 * machine-readable; `message` is display text. `AppError` is the only error type the
 * HTTP layer turns into an error envelope — anything else becomes `internal_error`
 * with a generic message.
 *
 * This lives at the platform root (not under `http/`) so the application layer can
 * throw typed errors without importing HTTP (AGENTS §3.2 dependency rule).
 */

export interface ErrorDescriptor {
  readonly status: number;
  readonly retryable: boolean;
  readonly message: string;
}

export const HTTP_ERRORS = {
  invalid_request: { status: 400, retryable: false, message: 'The request is invalid.' },
  unauthenticated: { status: 401, retryable: false, message: 'Authentication is required.' },
  forbidden: { status: 403, retryable: false, message: 'You do not have permission to do that.' },
  password_change_required: {
    status: 403,
    retryable: false,
    message: 'You must change your password before continuing.',
  },
  not_found: { status: 404, retryable: false, message: 'Not found.' },
  conflict: { status: 409, retryable: false, message: 'The resource is in a conflicting state.' },
  generation_in_progress: {
    status: 409,
    retryable: false,
    message: 'A generation is already running for this conversation.',
  },
  model_unavailable: { status: 409, retryable: false, message: 'This model is not available.' },
  idempotency_key_reuse: {
    status: 422,
    retryable: false,
    message: 'This idempotency key was used with a different request.',
  },
  unsupported_for_model: {
    status: 422,
    retryable: false,
    message: 'The request contains content this model does not support.',
  },
  context_too_large: {
    status: 422,
    retryable: false,
    message: 'The conversation is too large for this model.',
  },
  file_processing_failed: {
    status: 422,
    retryable: false,
    message: 'The file could not be processed.',
  },
  file_too_large: { status: 413, retryable: false, message: 'The file is too large.' },
  unsupported_file_type: {
    status: 415,
    retryable: false,
    message: 'This file type is not supported.',
  },
  file_not_ready: {
    status: 409,
    retryable: true,
    message: 'The file is still being processed.',
  },
  rate_limited: { status: 429, retryable: true, message: 'Too many requests.' },
  quota_exceeded: { status: 429, retryable: false, message: 'Your token quota is exhausted.' },
  concurrency_limit: {
    status: 429,
    retryable: true,
    message: 'Too many generations are already running.',
  },
  provider_unavailable: {
    status: 503,
    retryable: true,
    message: 'The model provider is unavailable.',
  },
  provider_rate_limited: {
    status: 503,
    retryable: true,
    message: 'The model provider is throttling requests.',
  },
  service_busy: { status: 503, retryable: true, message: 'The service is busy. Try again shortly.' },
  storage_unavailable: {
    status: 503,
    retryable: true,
    message: 'File storage is temporarily unavailable.',
  },
  internal_error: { status: 500, retryable: false, message: 'An internal error occurred.' },
} as const satisfies Record<string, ErrorDescriptor>;

export type HttpErrorCode = keyof typeof HTTP_ERRORS;

/** Codes that only ever appear inside a generation stream / persisted error. */
export type StreamErrorCode =
  | 'content_filtered'
  | 'generation_timeout'
  | 'generation_cancelled'
  | 'interrupted';

export type ErrorCode = HttpErrorCode | StreamErrorCode;

export interface AppErrorOptions {
  /** Override the HTTP status (e.g. `invalid_request` at 422). */
  readonly status?: number;
  /** Override the catalog's retryable hint. */
  readonly retryable?: boolean;
  /** Code-specific machine-readable payload (see API_CONTRACTS §14). */
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: HttpErrorCode, message?: string, options: AppErrorOptions = {}) {
    const descriptor = HTTP_ERRORS[code];
    super(message ?? descriptor.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? descriptor.status;
    this.retryable = options.retryable ?? descriptor.retryable;
    this.details = options.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

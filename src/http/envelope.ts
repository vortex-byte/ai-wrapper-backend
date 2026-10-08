import { AppError, HTTP_ERRORS, isAppError, type ErrorCode } from '../errors.ts';

/**
 * The wire envelope (`docs/API_CONTRACTS.md` §1). These builders are pure so they
 * can be unit-tested without an HTTP context; routes serialise them with `c.json`.
 */

export interface SuccessEnvelope<T> {
  readonly status: 'ok';
  readonly message: string;
  readonly data: T;
}

export interface SuccessEnvelopeEmpty {
  readonly status: 'ok';
  readonly message: string;
}

export interface ErrorEnvelope {
  readonly status: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly trace?: string;
}

/** Success with a payload. */
export function ok<T>(data: T, message = ''): SuccessEnvelope<T> {
  return { status: 'ok', message, data };
}

/** Success for operations that return nothing — the `data` key is omitted. */
export function okEmpty(message = ''): SuccessEnvelopeEmpty {
  return { status: 'ok', message };
}

export interface ErrorEnvelopeInput {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly trace?: string;
}

export function errorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelope {
  const body: {
    status: 'error';
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: unknown;
    trace?: string;
  } = {
    status: 'error',
    code: input.code,
    message: input.message,
    retryable: input.retryable,
  };
  if (input.details !== undefined) body.details = input.details;
  if (input.trace !== undefined) body.trace = input.trace;
  return body;
}

/**
 * Turn an unknown thrown value into an error envelope. `includeTrace` is true only
 * when `NODE_ENV=development`; the trace is the message only (never the raw stack
 * of a provider/SQL error) and is sanitised by the caller.
 */
export function envelopeFromError(
  error: unknown,
  options: { includeTrace: boolean; trace?: string | undefined } = { includeTrace: false },
): ErrorEnvelope {
  const appError = isAppError(error)
    ? error
    : new AppError('internal_error', HTTP_ERRORS.internal_error.message, { cause: error });

  const input: ErrorEnvelopeInput = {
    code: appError.code,
    message: appError.message,
    retryable: appError.retryable,
    details: appError.details,
  };

  if (options.includeTrace && options.trace !== undefined) {
    return errorEnvelope({ ...input, trace: options.trace });
  }
  return errorEnvelope(input);
}

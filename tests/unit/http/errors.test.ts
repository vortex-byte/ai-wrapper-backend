import { describe, expect, it } from 'vitest';
import { AppError, HTTP_ERRORS, isAppError } from '../../../src/http/errors.ts';

describe('AppError', () => {
  it('uses the catalog status, retryable and default message', () => {
    const error = new AppError('not_found');
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(HTTP_ERRORS.not_found.message);
    expect(error.code).toBe('not_found');
  });

  it('allows a status and message override', () => {
    const error = new AppError('invalid_request', 'Bad payload.', { status: 422 });
    expect(error.status).toBe(422);
    expect(error.message).toBe('Bad payload.');
  });

  it('carries machine-readable details', () => {
    const error = new AppError('quota_exceeded', undefined, { details: { resetAt: 'x' } });
    expect(error.details).toEqual({ resetAt: 'x' });
  });

  it('is recognised by isAppError', () => {
    expect(isAppError(new AppError('forbidden'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });

  it('marks transient provider failures retryable', () => {
    expect(new AppError('provider_unavailable').retryable).toBe(true);
    expect(new AppError('service_busy').status).toBe(503);
  });
});

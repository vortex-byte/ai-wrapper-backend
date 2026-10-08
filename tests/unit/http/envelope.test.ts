import { describe, expect, it } from 'vitest';
import { errorEnvelope, envelopeFromError, ok, okEmpty } from '../../../src/http/envelope.ts';
import { AppError } from '../../../src/http/errors.ts';

describe('success envelope', () => {
  it('always carries status/message and the payload under data', () => {
    expect(ok({ id: '1' }, 'Created.')).toEqual({
      status: 'ok',
      message: 'Created.',
      data: { id: '1' },
    });
  });

  it('omits the data key for empty results', () => {
    const body = okEmpty('Signed out.');
    expect(body).toEqual({ status: 'ok', message: 'Signed out.' });
    expect('data' in body).toBe(false);
  });
});

describe('error envelope', () => {
  it('omits details and trace when absent', () => {
    const body = errorEnvelope({
      code: 'not_found',
      message: 'Not found.',
      retryable: false,
    });
    expect(body).toEqual({
      status: 'error',
      code: 'not_found',
      message: 'Not found.',
      retryable: false,
    });
    expect('details' in body).toBe(false);
    expect('trace' in body).toBe(false);
  });

  it('includes details when present', () => {
    const body = errorEnvelope({
      code: 'quota_exceeded',
      message: 'No tokens.',
      retryable: false,
      details: { remainingTokens: 0 },
    });
    expect(body.details).toEqual({ remainingTokens: 0 });
  });

  it('maps a non-AppError to a generic internal_error', () => {
    const body = envelopeFromError(new Error('boom'), { includeTrace: false });
    expect(body).toMatchObject({ status: 'error', code: 'internal_error', retryable: false });
    expect('trace' in body).toBe(false);
  });

  it('adds a trace only when asked (development)', () => {
    const error = new AppError('internal_error');
    const withTrace = envelopeFromError(error, { includeTrace: true, trace: 'stack' });
    expect(withTrace.trace).toBe('stack');
    const without = envelopeFromError(error, { includeTrace: false, trace: 'stack' });
    expect('trace' in without).toBe(false);
  });
});

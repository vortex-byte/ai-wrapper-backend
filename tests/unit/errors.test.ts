import { describe, expect, it } from 'vitest';
import { isUniqueViolation, isUniqueViolationOf } from '@/errors.ts';

describe('unique violation detection', () => {
  it('accepts the node-postgres shape (SQLSTATE on code)', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('accepts the Bun SQL shape (SQLSTATE on errno)', () => {
    expect(isUniqueViolation({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' })).toBe(true);
  });

  it('walks the cause chain of wrapped query errors', () => {
    const wrapped = { message: 'query failed', cause: { errno: '23505' } };
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('matches a named constraint on the wrapped error', () => {
    const wrapped = {
      message: 'query failed',
      cause: { errno: '23505', constraint: 'users_email_live_uq' },
    };
    expect(isUniqueViolationOf(wrapped, 'users_email_live_uq')).toBe(true);
    expect(isUniqueViolationOf(wrapped, 'one_active_generation_per_conversation')).toBe(false);
  });
});

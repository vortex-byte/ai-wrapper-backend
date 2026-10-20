import { describe, expect, it } from 'vitest';
import { redactValue } from '@/reporting/domain/redaction.ts';

describe('redactValue', () => {
  it('redacts secret-bearing keys in audit before/after blobs', () => {
    const redacted = redactValue({
      email: 'a@corp.example',
      passwordHash: '$argon2id$...',
      secretRef: 'OPENAI_API_KEY',
      nested: { csrfToken: 'abc', role: 'admin' },
    });

    expect(redacted).toEqual({
      email: 'a@corp.example',
      passwordHash: '[redacted]',
      secretRef: '[redacted]',
      nested: { csrfToken: '[redacted]', role: 'admin' },
    });
  });

  it('keeps non-secret fields and handles arrays, nulls and dates', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(redactValue({ action: 'user.update', at: when, models: ['a', 'b'], divisionId: null })).toEqual(
      {
        action: 'user.update',
        at: '2026-01-02T03:04:05.000Z',
        models: ['a', 'b'],
        divisionId: null,
      },
    );
  });

  it('returns primitives unchanged', () => {
    expect(redactValue('plain')).toBe('plain');
    expect(redactValue(7)).toBe(7);
    expect(redactValue(null)).toBeNull();
  });
});
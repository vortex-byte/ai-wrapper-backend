import { describe, expect, it } from 'vitest';
import {
  CSRF_TOKEN_MAX_AGE_MS,
  issueCsrfToken,
  verifyCsrfToken,
} from '../../../src/csrf.ts';

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-05-01T10:00:00Z');

describe('csrf tokens', () => {
  it('round-trips a freshly issued token', () => {
    const token = issueCsrfToken(SECRET, { now: NOW });
    expect(verifyCsrfToken(SECRET, token, { now: NOW }).ok).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueCsrfToken('b'.repeat(48), { now: NOW });
    expect(verifyCsrfToken(SECRET, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload', () => {
    const token = issueCsrfToken(SECRET, { now: NOW });
    const [nonce, issuedAt, signature] = token.split('.');
    const tampered = `${nonce}.${Number(issuedAt) + 1}.${signature}`;
    expect(verifyCsrfToken(SECRET, tampered, { now: NOW }).reason).toBe('bad_signature');
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nope', 'a.b', 'a.b.c.d', '.1.sig', 'nonce.notanumber.sig']) {
      expect(verifyCsrfToken(SECRET, bad, { now: NOW }).reason).toBe('malformed');
    }
  });

  it('rejects an expired token', () => {
    const token = issueCsrfToken(SECRET, { now: NOW });
    const later = new Date(NOW.getTime() + CSRF_TOKEN_MAX_AGE_MS + 1);
    expect(verifyCsrfToken(SECRET, token, { now: later }).reason).toBe('expired');
  });

  it('accepts a token just inside the window', () => {
    const token = issueCsrfToken(SECRET, { now: NOW });
    const justInside = new Date(NOW.getTime() + CSRF_TOKEN_MAX_AGE_MS - 1);
    expect(verifyCsrfToken(SECRET, token, { now: justInside }).ok).toBe(true);
  });

  it('tolerates small clock skew into the future', () => {
    const token = issueCsrfToken(SECRET, { now: NOW });
    const slightlyEarly = new Date(NOW.getTime() - 5_000);
    expect(verifyCsrfToken(SECRET, token, { now: slightlyEarly }).ok).toBe(true);
  });

  it('produces distinct nonces', () => {
    const a = issueCsrfToken(SECRET, { now: NOW });
    const b = issueCsrfToken(SECRET, { now: NOW });
    expect(a).not.toBe(b);
  });
});

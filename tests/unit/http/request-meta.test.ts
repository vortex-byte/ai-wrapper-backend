import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { clientIp } from '@/http/request-meta.ts';
import { loadConfig } from '@/config/env.ts';
import type { AppEnv } from '@/http/types.ts';

function createMockContext(headers: Record<string, string>): Context<AppEnv> {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context<AppEnv>;
}

describe('clientIp', () => {
  const baseConfig = loadConfig({
    DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
    SESSION_SECRET: '01234567890123456789012345678901',
    NODE_ENV: 'test',
    TRUST_PROXY: 1,
  });

  it('extracts valid IPv4 or IPv6 when TRUST_PROXY > 0', () => {
    const cV4 = createMockContext({ 'x-forwarded-for': '198.51.100.1' });
    expect(clientIp(cV4, baseConfig)).toBe('198.51.100.1');

    const cV6 = createMockContext({ 'x-forwarded-for': '2001:db8::1' });
    expect(clientIp(cV6, baseConfig)).toBe('2001:db8::1');
  });

  it('rejects malformed or injected IP strings from x-forwarded-for', () => {
    const cInvalid = createMockContext({ 'x-forwarded-for': 'invalid-ip-string; DROP TABLE users;' });
    expect(clientIp(cInvalid, baseConfig)).toBeNull();
  });

  it('ignores x-forwarded-for when TRUST_PROXY is 0', () => {
    const noProxyConfig = { ...baseConfig, TRUST_PROXY: 0 };
    const c = createMockContext({ 'x-forwarded-for': '198.51.100.1' });
    expect(clientIp(c, noProxyConfig)).toBeNull();
  });
});

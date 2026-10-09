import type { Context } from 'hono';
import { getConnInfo } from '@hono/bun';
import type { Config } from '../config/index.ts';
import { hashUserAgent } from '../crypto.ts';
import type { RequestMeta } from '../request-context.ts';
import type { AppEnv } from './types.ts';

export function clientIp(c: Context<AppEnv>, config: Config): string | null {
  if (config.TRUST_PROXY > 0) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded !== undefined && forwarded !== '') {
      const hops = forwarded.split(',').map((part) => part.trim()).filter((p) => p !== '');
      const index = Math.max(0, hops.length - config.TRUST_PROXY);
      const candidate = hops[index];
      if (candidate !== undefined) return candidate;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function requestMeta(c: Context<AppEnv>, ip: string | null): RequestMeta {
  return {
    ip,
    userAgentHash: hashUserAgent(c.req.header('user-agent')),
    requestId: c.get('requestId') ?? null,
  };
}

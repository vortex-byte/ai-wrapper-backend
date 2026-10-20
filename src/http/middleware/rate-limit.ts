import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import type { RateLimiter } from '../ports/rate-limiter.ts';
import { clientIp } from '../request-meta.ts';
import type { AppEnv } from '../types.ts';

export type RateLimitScope = 'ip' | 'user';

export interface RateLimitRule {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly scope: RateLimitScope;
  readonly message?: string;
}

export function rateLimit(
  config: Config,
  rateLimiter: RateLimiter,
  rule: RateLimitRule,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = bucketKey(c, config, rule);
    const result = await rateLimiter.check(key, rule.limit, rule.windowSeconds);

    c.header('RateLimit-Limit', result.limit.toString());
    c.header('RateLimit-Remaining', result.remaining.toString());
    c.header('RateLimit-Reset', Math.ceil(result.resetAt.getTime() / 1000).toString());

    if (!result.allowed) {
      if (result.retryAfterSeconds !== undefined) {
        c.header('Retry-After', result.retryAfterSeconds.toString());
      }
      throw new AppError(
        'rate_limited',
        rule.message ?? 'Too many requests. Try again shortly.',
        { status: 429, retryable: true },
      );
    }

    await next();
  };
}

function bucketKey(
  c: Context<AppEnv>,
  config: Config,
  rule: RateLimitRule,
): string {
  const ip = clientIp(c, config);
  if (rule.scope === 'user') {
    const auth = c.get('auth');
    if (auth !== undefined) return `${rule.name}:user:${auth.user.id}`;
  }
  return `${rule.name}:ip:${ip ?? 'unknown'}`;
}

export function userRateLimit(
  config: Config,
  rateLimiter: RateLimiter,
  name = 'user',
): MiddlewareHandler<AppEnv> {
  return rateLimit(config, rateLimiter, {
    name,
    scope: 'user',
    limit: config.RATE_LIMIT_USER_REQUESTS,
    windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
  });
}

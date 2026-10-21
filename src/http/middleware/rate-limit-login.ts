import type { MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { getLogger } from '@/observability/logger.ts';
import { clientIp, requestMeta } from '../request-meta.ts';
import type { RateLimiter } from '../ports/rate-limiter.ts';
import type { AppEnv } from '../types.ts';
import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import { AUDIT_ACTIONS } from '@/audit/actions.ts';
import { hashUserAgent } from '@/crypto.ts';

export function rateLimitLogin(
  config: Config,
  rateLimiter: RateLimiter,
  audit?: AuditLogRepository,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rawIp = clientIp(c, config);
    const key =
      rawIp !== null
        ? `login:ip:${rawIp}`
        : `login:ua:${hashUserAgent(c.req.header('user-agent')) ?? 'unknown'}`;

    const result = await rateLimiter.check(
      key,
      config.RATE_LIMIT_LOGIN_REQUESTS,
      config.RATE_LIMIT_WINDOW_SECONDS,
    );

    c.header('RateLimit-Limit', result.limit.toString());
    c.header('RateLimit-Remaining', result.remaining.toString());
    c.header('RateLimit-Reset', Math.ceil(result.resetAt.getTime() / 1000).toString());

    if (!result.allowed) {
      if (result.retryAfterSeconds !== undefined) {
        c.header('Retry-After', result.retryAfterSeconds.toString());
      }

      if (audit) {
        const meta = requestMeta(c, rawIp);
        try {
          await audit.append({
            actorUserId: null,
            action: AUDIT_ACTIONS.loginRateLimited,
            targetType: 'ip',
            targetId: rawIp ?? '0.0.0.0',
            requestId: meta.requestId,
            ip: meta.ip,
            userAgentHash: meta.userAgentHash,
          });
        } catch (err) {
          getLogger().warn({ err }, 'failed to append audit log for login rate limit');
        }
      }

      throw new AppError('rate_limited', 'Too many login attempts from this IP. Try again shortly.', {
        status: 429,
        retryable: true,
      });
    }

    await next();
  };
}

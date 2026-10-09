import { Hono } from 'hono';
import type { Config } from '@/config/index.ts';
import { issueCsrfToken } from '@/csrf.ts';
import { AppError } from '@/errors.ts';
import { ok, okEmpty } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { enforceOrigin, requireCsrf } from '@/http/middleware/require-csrf.ts';
import {
  clearSessionCookie,
  setSessionCookie,
} from '@/http/middleware/session-cookie.ts';
import { clientIp, requestMeta } from '@/http/request-meta.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import type { AuthService } from '../application/auth-service.ts';
import type { User } from '../domain/user.ts';
import { ChangePasswordBodySchema, LoginBodySchema } from './schemas.ts';

import type { RateLimiter } from '@/http/ports/rate-limiter.ts';
import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import { rateLimitLogin } from '@/http/middleware/rate-limit-login.ts';

function toWireUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    divisionId: user.divisionId,
    mustChangePassword: user.mustChangePassword,
  };
}

export interface AuthRoutesDeps {
  readonly auth: AuthService;
  readonly config: Config;
  readonly rateLimiter?: RateLimiter;
  readonly audit?: AuditLogRepository;
}

export function authRoutes(deps: AuthRoutesDeps): Hono<AppEnv> {
  const { auth, config, rateLimiter, audit } = deps;
  const routes = new Hono<AppEnv>();

  if (rateLimiter) {
    routes.post('/auth/login', rateLimitLogin(config, rateLimiter, audit));
  }

  routes.post('/auth/login', enforceOrigin(config), async (c) => {
    const body = await parseJsonBody(c, LoginBodySchema);
    const meta = requestMeta(c, clientIp(c, config));
    const result = await auth.login({ email: body.email, password: body.password, meta });

    setSessionCookie(c, config, result.token);
    return c.json(
      ok(
        {
          user: toWireUser(result.user),
          csrfToken: issueCsrfToken(config.SESSION_SECRET),
        },
        'Signed in.',
      ),
    );
  });

  routes.delete('/auth/session', requireCsrf(config), requireAuth(auth, config), async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    await auth.logout({
      userId: current.user.id,
      sessionId: current.session.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    clearSessionCookie(c, config);
    return c.json(okEmpty('Signed out.'));
  });

  routes.post('/me/password', requireCsrf(config), requireAuth(auth, config), async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, ChangePasswordBodySchema);

    const result = await auth.changePassword({
      userId: current.user.id,
      sessionId: current.session.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      meta: requestMeta(c, clientIp(c, config)),
    });

    setSessionCookie(c, config, result.token);
    return c.json(
      ok({ csrfToken: issueCsrfToken(config.SESSION_SECRET) }, 'Password updated.'),
    );
  });

  return routes;
}

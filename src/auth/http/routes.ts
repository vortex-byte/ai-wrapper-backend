import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { Config } from '../../config/index.ts';
import { issueCsrfToken } from '../../csrf.ts';
import { AppError } from '../../errors.ts';
import { ok, okEmpty } from '../../http/envelope.ts';
import { requireAuth } from '../../http/middleware/require-auth.ts';
import { enforceOrigin, requireCsrf } from '../../http/middleware/require-csrf.ts';
import {
  clearSessionCookie,
  setSessionCookie,
} from '../../http/middleware/session-cookie.ts';
import { requestMeta } from '../../http/request-meta.ts';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AuthService } from '../application/auth-service.ts';
import type { User } from '../domain/user.ts';
import { ChangePasswordBodySchema, LoginBodySchema } from './schemas.ts';

/** Public shape of a user on the wire (API_CONTRACTS §2.1, §3.1). Never the hash. */
function toWireUser(user: User): {
  id: string;
  email: string;
  displayName: string;
  role: string;
  divisionId: string | null;
  mustChangePassword: boolean;
} {
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
}

/**
 * `/api/auth/*` and the password endpoint. Thin by design: parse → call the use case →
 * shape the response (AGENTS §3.3). All business rules live in the application layer.
 */
export function authRoutes(deps: AuthRoutesDeps): Hono<AppEnv> {
  const { auth, config } = deps;
  const routes = new Hono<AppEnv>();

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

  // Exempt from the password-change gate: this is how the user clears it.
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

/**
 * Client IP for auditing. `X-Forwarded-For` is honored **only** when the deployment
 * declares how many proxies sit in front (`TRUST_PROXY > 0`); otherwise it is a
 * spoofable header and we fall back to the socket address. Never trusted for
 * authorization — only for the audit trail and rate limiting.
 */
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

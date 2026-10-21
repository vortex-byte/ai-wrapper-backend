import { Hono } from 'hono';
import { issueCsrfToken } from '@/csrf.ts';
import { AppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import type { AppEnv } from '@/http/types.ts';
import type { Config } from '@/config/index.ts';
import type { AuthService } from '../application/auth-service.ts';

export interface MeRoutesDeps {
  readonly auth: AuthService;
  readonly config: Config;
}

export function meRoutes(deps: MeRoutesDeps): Hono<AppEnv> {
  const { auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.get('/me', requireAuth(auth, config), (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const { user } = current;
    return c.json(
      ok({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        divisionId: user.divisionId,
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt.toISOString(),
        csrfToken: issueCsrfToken(config.SESSION_SECRET),
      }),
    );
  });

  return routes;
}

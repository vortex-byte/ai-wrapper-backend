import { Hono } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { UserRole, UserStatus } from '@/auth/domain/user.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok, okEmpty } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { requireAdmin, requireSuperAdmin } from '@/http/middleware/require-role.ts';
import { clientIp, requestMeta } from '@/http/request-meta.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import type { AdminService, PublicUser } from '../application/admin-service.ts';
import {
  CreateDivisionBodySchema,
  CreateUserBodySchema,
  DivisionIdParamSchema,
  ListUsersQuerySchema,
  ResetUserPasswordBodySchema,
  UpdateDivisionBodySchema,
  UpdateUserBodySchema,
  UserIdParamSchema,
} from './schemas.ts';

export interface AdminRoutesDeps {
  readonly admin: AdminService;
  readonly auth: AuthService;
  readonly config: Config;
}

export interface WireUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly divisionId: string | null;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

function toWireUser(user: PublicUser): WireUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    divisionId: user.divisionId,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export function adminRoutes(deps: AdminRoutesDeps): Hono<AppEnv> {
  const { admin, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireCsrf(config));
  routes.use('*', requireAuth(auth, config));
  routes.use('*', requirePasswordChanged());
  routes.use('*', requireAdmin());
  routes.use('/divisions*', requireSuperAdmin());

  routes.get('/users', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const rawQuery = c.req.query();
    const parsed = ListUsersQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'Invalid query parameters.');
    }
    const queryInput = {
      ...parsed.data,
    };
    const callerCtx = {
      actorUserId: caller.user.id,
      role: caller.user.role,
      divisionId: caller.user.divisionId,
      meta: requestMeta(c, clientIp(c, config)),
    };
    const result = await admin.listUsers(queryInput, callerCtx);
    return c.json(
      ok(
        {
          items: result.items.map(toWireUser),
          nextCursor: result.nextCursor,
        },
        '',
      ),
    );
  });

  routes.post('/users', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, CreateUserBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    const result = await admin.createUser({
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      divisionId: body.divisionId,
      initialPassword: body.initialPassword,
      generatePassword: body.generatePassword,
      caller: {
        actorUserId: caller.user.id,
        role: caller.user.role,
        divisionId: caller.user.divisionId,
        meta,
      },
    });

    return c.json(
      ok(
        {
          ...toWireUser(result.user),
          ...(result.temporaryPassword ? { temporaryPassword: result.temporaryPassword } : {}),
        },
        'User created.',
      ),
      201,
    );
  });

  routes.get('/users/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = UserIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid user ID.');
    }
    const meta = requestMeta(c, clientIp(c, config));
    const user = await admin.getUser(parsedId.data, {
      actorUserId: caller.user.id,
      role: caller.user.role,
      divisionId: caller.user.divisionId,
      meta,
    });
    return c.json(ok(toWireUser(user)));
  });

  routes.patch('/users/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = UserIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid user ID.');
    }
    const body = await parseJsonBody(c, UpdateUserBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    const updated = await admin.updateUser({
      id: parsedId.data,
      displayName: body.displayName,
      role: body.role,
      status: body.status,
      divisionId: body.divisionId,
      caller: {
        actorUserId: caller.user.id,
        role: caller.user.role,
        divisionId: caller.user.divisionId,
        meta,
      },
    });

    return c.json(ok(toWireUser(updated), 'User updated.'));
  });

  routes.post('/users/:id/password/reset', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = UserIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid user ID.');
    }
    const body = await parseJsonBody(c, ResetUserPasswordBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    const result = await admin.resetUserPassword({
      id: parsedId.data,
      newPassword: body.newPassword,
      generatePassword: body.generatePassword,
      reason: body.reason,
      caller: {
        actorUserId: caller.user.id,
        role: caller.user.role,
        divisionId: caller.user.divisionId,
        meta,
      },
    });

    if (result.temporaryPassword) {
      return c.json(
        ok({ temporaryPassword: result.temporaryPassword }, 'Password reset.'),
      );
    }
    return c.json(okEmpty('Password reset.'));
  });

  routes.get('/divisions', async (c) => {
    const divisions = await admin.listDivisions();
    return c.json(
      ok({
        items: divisions.map((d) => ({
          id: d.id,
          name: d.name,
          externalRef: d.externalRef,
          createdAt: d.createdAt.toISOString(),
        })),
      }),
    );
  });

  routes.post('/divisions', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, CreateDivisionBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    const division = await admin.createDivision({
      name: body.name,
      externalRef: body.externalRef,
      actorUserId: caller.user.id,
      meta,
    });

    return c.json(
      ok(
        {
          id: division.id,
          name: division.name,
          externalRef: division.externalRef,
          createdAt: division.createdAt.toISOString(),
        },
        'Division created.',
      ),
      201,
    );
  });

  routes.patch('/divisions/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = DivisionIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid division ID.');
    }
    const body = await parseJsonBody(c, UpdateDivisionBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    const division = await admin.updateDivision({
      id: parsedId.data,
      name: body.name,
      externalRef: body.externalRef,
      actorUserId: caller.user.id,
      meta,
    });

    return c.json(
      ok(
        {
          id: division.id,
          name: division.name,
          externalRef: division.externalRef,
          createdAt: division.createdAt.toISOString(),
        },
        'Division updated.',
      ),
    );
  });

  return routes;
}

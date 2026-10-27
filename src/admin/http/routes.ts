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
import type { Division, DivisionWithStats } from '../ports/division-repository.ts';
import { CSV_TEMPLATE_CONTENT, CSV_TEMPLATE_FILENAME, parseCsv } from './csv.ts';
import {
  CreateDivisionBodySchema,
  CreateUserBodySchema,
  DivisionIdParamSchema,
  ImportUsersBodySchema,
  ListDivisionsQuerySchema,
  ListUsersQuerySchema,
  ResetUserPasswordBodySchema,
  UpdateDivisionBodySchema,
  UpdateUserBodySchema,
  UserIdParamSchema,
  type ImportUsersRow,
} from './schemas.ts';

const MAX_IMPORT_BYTES = 1_000_000;

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

export interface WireDivision {
  readonly id: string;
  readonly name: string;
  readonly externalRef: string | null;
  readonly createdAt: string;
}

export interface WireDivisionWithStats extends WireDivision {
  readonly memberCount: number;
  readonly tokens: number;
  readonly requests: number;
  readonly costUsd: number | null;
  readonly monthlyTokens: number | null;
}

function toWireDivision(division: Division): WireDivision {
  return {
    id: division.id,
    name: division.name,
    externalRef: division.externalRef,
    createdAt: division.createdAt.toISOString(),
  };
}

function toWireDivisionWithStats(division: DivisionWithStats): WireDivisionWithStats {
  return {
    ...toWireDivision(division),
    memberCount: division.memberCount,
    tokens: division.tokens,
    requests: division.requests,
    costUsd: division.costUsd,
    monthlyTokens: division.monthlyTokens,
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
      password: body.password,
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

  routes.get('/users/import/template', () => {
    return new Response(CSV_TEMPLATE_CONTENT, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${CSV_TEMPLATE_FILENAME}"`,
      },
    });
  });

  routes.post('/users/import', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const meta = requestMeta(c, clientIp(c, config));

    const contentType = c.req.header('content-type') ?? '';
    let rows: ImportUsersRow[];
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody({ all: true });
      const file = body['file'];
      if (!(file instanceof File)) {
        throw new AppError('invalid_request', 'A multipart "file" part with a CSV is required.');
      }
      if (file.size > MAX_IMPORT_BYTES) {
        throw new AppError('invalid_request', 'The CSV file is too large.');
      }
      const parsed = parseCsv(await file.text());
      if (parsed.rows.length === 0) {
        throw new AppError(
          'invalid_request',
          'The CSV must have an "email,name,division" header and at least one data row.',
        );
      }
      if (parsed.malformed.length > 0) {
        throw new AppError(
          'invalid_request',
          `Rows ${parsed.malformed.join(', ')} are missing an email or name.`,
        );
      }
      rows = parsed.rows;
    } else {
      const body = await parseJsonBody(c, ImportUsersBodySchema);
      rows = body.rows;
    }

    const result = await admin.importUsers({
      rows,
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
          summary: {
            total: rows.length,
            created: result.created.length,
            skipped: result.errors.length,
          },
          temporaryPassword: result.temporaryPassword,
          createdUsers: result.created,
          errors: result.errors,
        },
        'Bulk registration processed.',
      ),
      200,
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
      email: body.email,
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

  routes.delete('/users/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = UserIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid user ID.');
    }
    const meta = requestMeta(c, clientIp(c, config));

    await admin.deleteUser({
      id: parsedId.data,
      caller: {
        actorUserId: caller.user.id,
        role: caller.user.role,
        divisionId: caller.user.divisionId,
        meta,
      },
    });

    return c.json(okEmpty('User deleted.'));
  });

  routes.get('/divisions', async (c) => {
    const query = ListDivisionsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw new AppError('invalid_request', 'Invalid query parameters.');
    }
    const divisions = await admin.listDivisions(query.data.days);
    return c.json(ok({ items: divisions.map(toWireDivisionWithStats) }));
  });

  routes.get('/divisions/:id', async (c) => {
    const parsedId = DivisionIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid division ID.');
    }
    const query = ListDivisionsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw new AppError('invalid_request', 'Invalid query parameters.');
    }
    const division = await admin.getDivision(parsedId.data, query.data.days);
    return c.json(ok(toWireDivisionWithStats(division)));
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

    return c.json(ok(toWireDivision(division), 'Division created.'), 201);
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

    return c.json(ok(toWireDivision(division), 'Division updated.'));
  });

  routes.delete('/divisions/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsedId = DivisionIdParamSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new AppError('invalid_request', 'Invalid division ID.');
    }

    await admin.deleteDivision({
      id: parsedId.data,
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });

    return c.json(okEmpty('Division deleted.'));
  });

  return routes;
}

import { z } from 'zod';
import { Hono } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { requireSuperAdmin } from '@/http/middleware/require-role.ts';
import { clientIp, requestMeta } from '@/http/request-meta.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import type { QuotaService } from '../application/quota-service.ts';
import type { UsageService } from '../application/usage-service.ts';

/** Quota and usage read endpoints. */

const UUID = z.uuid();

export const PolicyUpsertBodySchema = z.object({
  monthlyTokens: z.number().int().min(0).nullable().optional(),
  maxInputTokensPerRequest: z.number().int().min(1).nullable().optional(),
  maxOutputTokensPerRequest: z.number().int().min(1).nullable().optional(),
  maxConcurrentGenerations: z.number().int().min(1).nullable().optional(),
  allowedModelIds: z.array(z.uuid()).nullable().optional(),
  applyToCurrentPeriod: z.boolean().optional().default(true),
  reason: z.string().min(1).max(500).optional(),
});

export const AdjustmentBodySchema = z.object({
  tokens: z
    .number()
    .int()
    .refine((v) => v !== 0, 'tokens must be non-zero'),
  reason: z.string().min(1).max(500),
  expiresAtPeriodEnd: z.boolean().optional().default(true),
});

const USAGE_GROUP_BY = z.enum(['day', 'model']).optional().default('day');

export interface QuotaRoutesDeps {
  readonly quota: QuotaService;
  readonly usage: UsageService;
  readonly audit: AuditLogRepository;
  readonly auth: AuthService;
  readonly config: Config;
}

export function quotaRoutes(deps: QuotaRoutesDeps): Hono<AppEnv> {
  const { quota, usage, audit, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  const user = new Hono<AppEnv>();
  user.use('/me/*', requireCsrf(config));
  user.use('/me/*', requireAuth(auth, config));
  user.use('/me/*', requirePasswordChanged());

  user.get('/me/quota', async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const snapshot = await quota.getQuotaSnapshot(current.user.id);
    if (snapshot === null) throw new AppError('not_found', 'No quota period found.');
    return c.json(ok(snapshot));
  });

  user.get('/me/usage', async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const parsed = USAGE_GROUP_BY.safeParse(c.req.query('groupBy'));
    const groupBy = parsed.success ? parsed.data : 'day';
    const items = await usage.userUsage({
      userId: current.user.id,
      from: c.req.query('from'),
      to: c.req.query('to'),
      groupBy,
    });
    return c.json(
      ok({
        items: items.map((item) => ({
          key: item.modelId !== null ? { modelId: item.modelId } : { day: item.day },
          requests: item.requests,
          failedRequests: item.failedRequests,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          quotaTokens: item.quotaTokens,
          estimatedCostUsd: item.estimatedCostUsd,
        })),
      }),
    );
  });

  routes.route('/', user);

  const admin = new Hono<AppEnv>();
  admin.use('/admin/*', requireCsrf(config));
  admin.use('/admin/*', requireAuth(auth, config));
  admin.use('/admin/*', requirePasswordChanged());
  admin.use('/admin/*', requireSuperAdmin());

  admin.get('/admin/quota-policies/:scope/:id?', async (c) => {
    const scope = parseScope(c.req.param('scope'));
    const targetId = normalizeTarget(scope, c.req.param('id'));
    const policy = await quota.getPolicy(scope, targetId);
    if (policy === null) throw new AppError('not_found', 'No quota policy at this scope.');
    return c.json(ok(wirePolicy(policy)));
  });

  admin.put('/admin/quota-policies/:scope/:id?', async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const scope = parseScope(c.req.param('scope'));
    const targetId = normalizeTarget(scope, c.req.param('id'));
    const body = await parseJsonBody(c, PolicyUpsertBodySchema);
    const saved = await quota.updatePolicy({
      scope,
      targetId,
      fields: {
        monthlyTokens: body.monthlyTokens,
        maxInputTokensPerRequest: body.maxInputTokensPerRequest,
        maxOutputTokensPerRequest: body.maxOutputTokensPerRequest,
        maxConcurrentGenerations: body.maxConcurrentGenerations,
        allowedModelIds: body.allowedModelIds,
      },
      applyToCurrentPeriod: body.applyToCurrentPeriod,
      reason: body.reason,
      actorUserId: current.user.id,
      requestId: c.get('requestId'),
      ip: clientIp(c, config),
      userAgentHash: requestMeta(c, clientIp(c, config)).userAgentHash,
    });
    return c.json(ok(wirePolicy(saved), 'Quota policy updated.'));
  });

  admin.post('/admin/users/:id/quota/adjustments', async (c) => {
    const current = c.get('auth');
    if (current === undefined) throw new AppError('unauthenticated');
    const userId = UUID.parse(c.req.param('id'));
    const body = await parseJsonBody(c, AdjustmentBodySchema);
    const result = await quota.adjustQuota({
      userId,
      tokens: body.tokens,
      reason: body.reason,
      actorUserId: current.user.id,
      requestId: c.get('requestId'),
    });
    await audit.append({
      actorUserId: current.user.id,
      action: 'quota.adjustment.applied',
      targetType: 'user',
      targetId: userId,
      after: { tokensDelta: result.tokensDelta, reason: body.reason },
      requestId: c.get('requestId'),
      ip: clientIp(c, config),
      userAgentHash: requestMeta(c, clientIp(c, config)).userAgentHash,
    });
    return c.json(ok(result, 'Adjustment applied.'));
  });

  admin.get('/admin/users/:id/quota', async (c) => {
    const userId = UUID.parse(c.req.param('id'));
    const snapshot = await quota.getQuotaSnapshot(userId);
    if (snapshot === null) throw new AppError('not_found', 'No quota period found.');
    const ledger = await quota.listLedger(userId, 50);
    return c.json(
      ok({
        period: snapshot.period,
        limitTokens: snapshot.limitTokens,
        usedTokens: snapshot.usedTokens,
        reservedTokens: snapshot.reservedTokens,
        remainingTokens: snapshot.remainingTokens,
        limits: snapshot.limits,
        ledger: ledger.map((entry) => ({
          entryType: entry.entryType,
          tokensDelta: entry.tokensDelta,
          reason: entry.reason,
          createdAt: entry.createdAt.toISOString(),
          requestId: entry.requestId,
        })),
      }),
    );
  });

  routes.route('/', admin);

  return routes;
}

function parseScope(raw: string | undefined): 'global' | 'division' | 'user' {
  if (raw === 'global' || raw === 'division' || raw === 'user') return raw;
  throw new AppError('invalid_request', 'scope must be one of global, division, user.');
}

function normalizeTarget(
  scope: 'global' | 'division' | 'user',
  rawId: string | undefined,
): string | null {
  if (scope === 'global') return null;
  if (rawId === undefined) {
    throw new AppError('invalid_request', `${scope} scope requires a target id.`);
  }
  return UUID.parse(rawId);
}

function wirePolicy(policy: {
  readonly scope: string;
  readonly divisionId: string | null;
  readonly userId: string | null;
  readonly monthlyTokens: number | null;
  readonly maxInputTokensPerRequest: number | null;
  readonly maxOutputTokensPerRequest: number | null;
  readonly maxConcurrentGenerations: number | null;
  readonly allowedModelIds: readonly string[] | null;
  readonly updatedBy?: string | null;
  readonly updatedAt?: Date;
}): Record<string, unknown> {
  return {
    scope: policy.scope,
    divisionId: policy.divisionId,
    userId: policy.userId,
    monthlyTokens: policy.monthlyTokens,
    maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
    maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
    maxConcurrentGenerations: policy.maxConcurrentGenerations,
    allowedModelIds: policy.allowedModelIds,
    ...(policy.updatedAt !== undefined ? { updatedAt: policy.updatedAt.toISOString() } : {}),
  };
}

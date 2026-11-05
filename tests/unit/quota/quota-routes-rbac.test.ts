import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/index.ts';
import { loadConfig } from '@/config/index.ts';
import { isAppError } from '@/errors.ts';
import type { AppEnv } from '@/http/types.ts';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { QuotaService } from '@/quota/application/quota-service.ts';
import type { UsageService } from '@/quota/application/usage-service.ts';
import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import { quotaRoutes } from '@/quota/http/routes.ts';
import { issueCsrfToken } from '@/csrf.ts';
import type { User } from '@/auth/domain/user.ts';

const ORIGIN = 'https://app.corp.example';
const SECRET = 'a'.repeat(48);

function testConfig(): Config {
  return loadConfig({
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/aichat_test',
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    NODE_ENV: 'test',
  });
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@corp.example',
    displayName: 'Test User',
    passwordHash: 'hash',
    passwordUpdatedAt: new Date(),
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    role: 'user',
    status: 'active',
    divisionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function fakeAuth(user: User): AuthService {
  return {
    login: async () => {
      throw new Error('not used');
    },
    logout: async () => {},
    changePassword: async () => {
      throw new Error('not used');
    },
    resolveSession: async () => ({
      user,
      session: {
        id: 'session-1',
        userId: user.id,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        rotatedFrom: null,
      },
    }),
  };
}

function buildTestApp(currentUser: User, usersMap: Map<string, { id: string; divisionId: string | null }>) {
  const config = testConfig();
  const auth = fakeAuth(currentUser);

  const mockQuota: Partial<QuotaService> = {
    findUser: async (userId: string) => usersMap.get(userId) ?? null,
    getQuotaSnapshot: async () => ({
      period: { start: new Date().toISOString(), end: new Date().toISOString() },
      limitTokens: 100_000,
      usedTokens: 10_000,
      reservedTokens: 0,
      remainingTokens: 90_000,
      limits: {
        maxInputTokensPerRequest: 10_000,
        maxOutputTokensPerRequest: 4_000,
        maxConcurrentGenerations: 2,
      },
    }),
    listLedger: async () => [],
    adjustQuota: async () => ({
      entryType: 'grant',
      tokensDelta: 50_000,
    }),
    getPolicy: async (scope, targetId) => ({
      id: 'pol-1',
      scope,
      divisionId: scope === 'division' ? targetId : null,
      userId: scope === 'user' ? targetId : null,
      monthlyTokens: 200_000,
      maxInputTokensPerRequest: null,
      maxOutputTokensPerRequest: null,
      maxConcurrentGenerations: null,
      allowedModelIds: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updatePolicy: async (input) => ({
      id: 'pol-1',
      scope: input.scope,
      divisionId: input.scope === 'division' ? input.targetId : null,
      userId: input.scope === 'user' ? input.targetId : null,
      monthlyTokens: input.fields.monthlyTokens ?? null,
      maxInputTokensPerRequest: input.fields.maxInputTokensPerRequest ?? null,
      maxOutputTokensPerRequest: input.fields.maxOutputTokensPerRequest ?? null,
      maxConcurrentGenerations: input.fields.maxConcurrentGenerations ?? null,
      allowedModelIds: input.fields.allowedModelIds ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  const mockUsage: Partial<UsageService> = {};
  const mockAudit: Partial<AuditLogRepository> = {
    append: async () => {},
  };

  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (isAppError(err)) {
      return c.json({ status: 'error', code: err.code, message: err.message }, err.status as 400);
    }
    return c.json({ status: 'error', code: 'internal', message: 'Internal error' }, 500);
  });

  const routes = quotaRoutes({
    quota: mockQuota as QuotaService,
    usage: mockUsage as UsageService,
    audit: mockAudit as AuditLogRepository,
    auth,
    config,
  });

  app.route('/api', routes);
  return app;
}

describe('Quota routes RBAC', () => {
  const deptId = '11111111-1111-4111-8111-111111111111';
  const otherDeptId = '22222222-2222-4222-8222-222222222222';
  const memberId = '33333333-3333-4333-8333-333333333333';
  const otherMemberId = '44444444-4444-4444-8444-444444444444';

  const usersMap = new Map<string, { id: string; divisionId: string | null }>([
    [memberId, { id: memberId, divisionId: deptId }],
    [otherMemberId, { id: otherMemberId, divisionId: otherDeptId }],
  ]);

  const deptAdmin = makeUser({
    id: 'admin-1',
    role: 'admin',
    divisionId: deptId,
  });

  const superAdmin = makeUser({
    id: 'super-1',
    role: 'super_admin',
    divisionId: null,
  });

  const regularUser = makeUser({
    id: 'user-regular',
    role: 'user',
    divisionId: deptId,
  });

  it('allows department admin to view quota for a member in their division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/users/${memberId}/quota`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; data: { remainingTokens: number } };
    expect(body.status).toBe('ok');
    expect(body.data.remainingTokens).toBe(90_000);
  });

  it('rejects department admin trying to view quota for a member in another division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/users/${otherMemberId}/quota`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('You do not have permission to do that.');
  });

  it('rejects standard users from accessing admin quota endpoints', async () => {
    const app = buildTestApp(regularUser, usersMap);
    const res = await app.request(`/api/admin/users/${memberId}/quota`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(403);
  });

  it('allows department admin to adjust quota for a member in their division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/users/${memberId}/quota/adjustments`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tokens: 50_000,
        reason: 'Monthly allocation grant',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; data: { tokensDelta: number } };
    expect(body.status).toBe('ok');
    expect(body.data.tokensDelta).toBe(50_000);
  });

  it('allows super admin to adjust quota for a user inside a department', async () => {
    const app = buildTestApp(superAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/users/${memberId}/quota/adjustments`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tokens: 50_000,
        reason: 'Super admin adjustment',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; data: { tokensDelta: number } };
    expect(body.status).toBe('ok');
    expect(body.data.tokensDelta).toBe(50_000);
  });

  it('rejects department admin trying to adjust quota for a user in another division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/users/${otherMemberId}/quota/adjustments`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tokens: 50_000,
        reason: 'Cross-division adjustment',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('allows department admin to read policy for their own division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/quota-policies/division/${deptId}`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(200);
  });

  it('rejects department admin trying to read policy for another division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/quota-policies/division/${otherDeptId}`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(403);
  });

  it('allows department admin to read policy for a user in their division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/quota-policies/user/${memberId}`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(200);
  });

  it('rejects department admin trying to read policy for a user in another division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const res = await app.request(`/api/admin/quota-policies/user/${otherMemberId}`, {
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
      },
    });
    expect(res.status).toBe(403);
  });

  it('allows super admin to update user policy for a user inside a department', async () => {
    const app = buildTestApp(superAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/quota-policies/user/${memberId}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ monthlyTokens: 750_000 }),
    });
    expect(res.status).toBe(200);
  });

  it('allows department admin to update user policy for a user in their division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/quota-policies/user/${memberId}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ monthlyTokens: 750_000 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects department admin trying to update user policy for another division', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/quota-policies/user/${otherMemberId}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ monthlyTokens: 750_000 }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects department admin trying to update the division policy', async () => {
    const app = buildTestApp(deptAdmin, usersMap);
    const csrfToken = issueCsrfToken(SECRET);
    const res = await app.request(`/api/admin/quota-policies/division/${deptId}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Cookie: '__Host-session=session-1',
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ monthlyTokens: 750_000 }),
    });
    expect(res.status).toBe(403);
  });
});

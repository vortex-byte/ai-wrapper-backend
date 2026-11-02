import type { SeedAuditLog, SeedDailyUsage, SeedErrorEvent } from './types.ts';

function padId(n: number): string {
  return n.toString().padStart(6, '0');
}

export function buildSeedAuditLogs(): SeedAuditLog[] {
  const result: SeedAuditLog[] = [];
  const baseDate = new Date('2026-11-02T08:00:00Z');

  const actions = [
    {
      action: 'user.login',
      targetType: 'user',
      before: null,
      after: { ip: '10.100.4.15', method: 'password' },
    },
    {
      action: 'user.created',
      targetType: 'user',
      before: null,
      after: { role: 'user', division: 'Engineering' },
    },
    {
      action: 'user.role_updated',
      targetType: 'user',
      before: { role: 'user' },
      after: { role: 'admin' },
    },
    {
      action: 'user.password_reset',
      targetType: 'user',
      before: null,
      after: { temporaryPasswordIssued: true },
    },
    {
      action: 'division.created',
      targetType: 'division',
      before: null,
      after: { name: 'Data Science & AI' },
    },
    {
      action: 'division.updated',
      targetType: 'division',
      before: { monthlyTokens: 80000000 },
      after: { monthlyTokens: 100000000 },
    },
    {
      action: 'model.status_updated',
      targetType: 'model',
      before: { status: 'disabled' },
      after: { status: 'active' },
    },
    {
      action: 'model.capabilities_updated',
      targetType: 'model',
      before: { vision: false },
      after: { vision: true },
    },
    {
      action: 'quota.policy_updated',
      targetType: 'quota_policy',
      before: { maxOutputTokens: 4096 },
      after: { maxOutputTokens: 8192 },
    },
    {
      action: 'quota.adjustment',
      targetType: 'quota_account',
      before: { adjustmentTokens: 0 },
      after: { adjustmentTokens: 5000000, reason: 'Q4 project bonus grant' },
    },
    {
      action: 'settings.updated',
      targetType: 'system_settings',
      before: { timezone: 'UTC' },
      after: { timezone: 'Asia/Jakarta' },
    },
    {
      action: 'user.logout',
      targetType: 'session',
      before: { active: true },
      after: { revoked: true },
    },
  ];

  const actors = [
    'superadmin@corp.example',
    'platform.admin@corp.example',
    'rachel.green@corp.example',
    'alex.mercer@corp.example',
    'elena.rostova@corp.example',
  ];

  // 75 audit log entries (exceeds default limit of 50 to trigger pagination!)
  for (let i = 0; i < 75; i++) {
    const actionTemplate = actions[i % actions.length];
    const actorEmail = actors[i % actors.length];
    if (!actionTemplate || !actorEmail) continue;
    const hoursAgo = i * 8; // spaced out over ~25 days
    const date = new Date(baseDate.getTime() - hoursAgo * 3600_000);
    const targetId = `00000000-0000-7000-8002-${padId((i % 30) + 1).padStart(12, '0')}`;

    result.push({
      action: actionTemplate.action,
      actorEmail,
      targetType: actionTemplate.targetType,
      targetId,
      before: actionTemplate.before,
      after: actionTemplate.after,
      ip: `10.100.${(i % 10) + 1}.${(i % 250) + 1}`,
      requestId: `req_audit_${padId(i + 1)}`,
      createdAt: date,
    });
  }

  return result;
}

export function buildSeedErrorEvents(): SeedErrorEvent[] {
  const result: SeedErrorEvent[] = [];
  const baseDate = new Date('2026-11-02T08:30:00Z');

  const errorPrototypes = [
    {
      component: 'openai_adapter',
      category: 'upstream_timeout',
      message: 'Upstream provider call to api.openai.com timed out after 60,000ms',
      providerKey: 'openai',
      apiModelId: 'gpt-4o',
      context: { timeoutMs: 60000, streamAttempt: 1, method: 'POST' },
    },
    {
      component: 'anthropic_adapter',
      category: 'provider_rate_limited',
      message: 'Anthropic rate limit reached (HTTP 429). Retry after 25 seconds.',
      providerKey: 'anthropic',
      apiModelId: 'claude-3-5-sonnet-latest',
      context: { statusCode: 429, retryAfterSeconds: 25 },
    },
    {
      component: 'gemini_adapter',
      category: 'upstream_5xx',
      message: 'Upstream 502 Bad Gateway received from Google Gemini endpoint',
      providerKey: 'gemini',
      apiModelId: 'gemini-2.0-flash',
      context: { statusCode: 502, errorBody: 'Server temporarily unavailable' },
    },
    {
      component: 'context_builder',
      category: 'context_length_exceeded',
      message: 'Total tokens (134,800) exceeded model context window limit of 128,000',
      providerKey: 'openai',
      apiModelId: 'gpt-4o',
      context: { requestedTokens: 134800, maxContext: 128000, truncated: true },
    },
    {
      component: 'orchestrator',
      category: 'content_filter_triggered',
      message: 'Provider flagged generation chunk under safety policy: code_injection_attempt',
      providerKey: 'openai',
      apiModelId: 'gpt-4o',
      context: { safetyPolicy: 'code_safety', finishReason: 'content_filter' },
    },
    {
      component: 'quota_service',
      category: 'quota_exceeded',
      message: 'User allocation exceeded division monthly token limit',
      providerKey: 'anthropic',
      apiModelId: 'claude-3-5-sonnet-latest',
      context: { usedTokens: 52140000, limitTokens: 50000000 },
    },
    {
      component: 'orchestrator',
      category: 'network_reset',
      message: 'TLS socket connection reset by peer during chunk streaming',
      providerKey: 'openai',
      apiModelId: 'o3-mini',
      context: { socketError: 'ECONNRESET', chunksReceived: 42 },
    },
    {
      component: 'quota_service',
      category: 'concurrency_limit',
      message: 'User exceeded maximum concurrent active generations (limit: 2)',
      providerKey: 'anthropic',
      apiModelId: 'claude-3-7-sonnet-latest',
      context: { activeGenerations: 2, limit: 2 },
    },
  ];

  // 65 error events (exceeds default limit of 50 to trigger pagination!)
  for (let i = 0; i < 65; i++) {
    const proto = errorPrototypes[i % errorPrototypes.length];
    if (!proto) continue;
    const hoursAgo = i * 6; // spread over ~16 days
    const date = new Date(baseDate.getTime() - hoursAgo * 3600_000);

    result.push({
      component: proto.component,
      category: proto.category,
      message: proto.message,
      context: proto.context,
      providerKey: proto.providerKey,
      apiModelId: proto.apiModelId,
      requestId: `req_err_${padId(i + 1)}`,
      occurredAt: date,
    });
  }

  return result;
}

export function buildSeedDailyUsage(): SeedDailyUsage[] {
  const result: SeedDailyUsage[] = [];

  // 30 days of usage for top users and models
  const usersAndDivisions = [
    { email: 'sarah.chen@corp.example', division: 'Engineering' },
    { email: 'david.kim@corp.example', division: 'Engineering' },
    { email: 'jordan.taylor@corp.example', division: 'Product & Design' },
    { email: 'arjun.mehta@corp.example', division: 'Data Science & AI' },
  ];

  const models = [
    { provider: 'openai', model: 'gpt-4o', costPerK: 6 },
    { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', costPerK: 8 },
    { provider: 'openai', model: 'gpt-4o-mini', costPerK: 0.3 },
    { provider: 'gemini', model: 'gemini-2.0-flash', costPerK: 0.25 },
  ];

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const d = new Date('2026-11-02T00:00:00Z');
    d.setDate(d.getDate() - dayOffset);
    const dayStr = d.toISOString().slice(0, 10);

    for (let uIdx = 0; uIdx < usersAndDivisions.length; uIdx++) {
      const u = usersAndDivisions[uIdx];
      const model = models[(dayOffset + uIdx) % models.length];
      if (!u || !model) continue;

      // Realistic variation per day
      const requests = 15 + ((dayOffset * 3 + uIdx * 7) % 25);
      const failedRequests = (dayOffset % 7 === 0) ? 1 : 0;
      const inputTokens = requests * (1200 + ((dayOffset * 73) % 800));
      const outputTokens = requests * (450 + ((dayOffset * 47) % 350));
      const quotaTokens = inputTokens + outputTokens;
      const estCostMicros = Math.round((quotaTokens / 1000) * model.costPerK * 1000);

      result.push({
        day: dayStr,
        userEmail: u.email,
        divisionName: u.division,
        providerKey: model.provider,
        apiModelId: model.model,
        requests,
        failedRequests,
        inputTokens,
        outputTokens,
        quotaTokens,
        estCostMicros,
      });
    }
  }

  return result;
}

import { getConfig } from '../config/index.ts';
import { getPool } from './pool.ts';
import { withTransaction, type TransactionContext } from './tx.ts';
import {
  SEED_PROVIDERS,
  SEED_MODELS,
  SEED_MODEL_PRICES,
} from './seed-data/providers-models.ts';
import {
  SEED_DIVISIONS,
  SEED_USERS,
  SEED_QUOTA_POLICIES,
} from './seed-data/divisions-users.ts';
import {
  SEED_ATTACHMENTS,
  buildSeedConversations,
  buildSeedMessages,
} from './seed-data/conversations-messages.ts';
import {
  buildSeedAuditLogs,
  buildSeedErrorEvents,
  buildSeedDailyUsage,
} from './seed-data/reporting-data.ts';
import type { SeedMessage } from './seed-data/types.ts';

export interface SeedResult {
  readonly seeded: boolean;
  readonly reason: string;
  readonly inserted: Readonly<Record<string, number>>;
}

export interface ExampleProvider {
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly secretRef: string;
}

export interface ExampleModel {
  readonly providerKey: string;
  readonly apiModelId: string;
  readonly displayName: string;
}

export const EXAMPLE_PROVIDERS: readonly ExampleProvider[] = SEED_PROVIDERS.map((p) => ({
  key: p.key,
  displayName: p.displayName,
  adapter: p.adapter,
  secretRef: p.secretRef,
}));

export const EXAMPLE_MODELS: readonly ExampleModel[] = SEED_MODELS.map((m) => ({
  providerKey: m.providerKey,
  apiModelId: m.apiModelId,
  displayName: m.displayName,
}));

/** True when the provider registry table exists. */
async function registryTablesPresent(): Promise<boolean> {
  const { rows } = await getPool().query<{ present: string | null }>(
    `SELECT to_regclass('public.ai_providers')::text AS present`,
  );
  return rows[0]?.present !== null && rows[0]?.present !== undefined;
}

const ARGON2_SEED_OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 65_536,
  timeCost: 3,
  hashLength: 32,
} as const;

interface SeedContext {
  readonly tx: TransactionContext;
  readonly inserted: Record<string, number>;
  readonly defaultPasswordHash: string;
  readonly divisionIdByName: Map<string, string>;
  readonly userIdByEmail: Map<string, string>;
  readonly accountIdByUserId: Map<string, string>;
  readonly providerIdByKey: Map<string, string>;
  readonly modelIdByProviderAndApiModel: Map<string, string>;
}

const SEED_SETTINGS = [
  { key: 'quota.timezone', value: JSON.stringify('Asia/Jakarta') },
  { key: 'retention.days', value: JSON.stringify(30) },
  { key: 'retention.files_hours', value: JSON.stringify(24) },
  {
    key: 'system.prompt.default',
    value: JSON.stringify(
      'You are an internal office AI assistant. Be direct, professional, concise, and helpful.',
    ),
  },
];

function addInserted(ctx: SeedContext, key: string, rowCount: number | null): void {
  ctx.inserted[key] = (ctx.inserted[key] ?? 0) + (rowCount ?? 0);
}

function emptyInsertedCounts(): Record<string, number> {
  return {
    settings: 0,
    divisions: 0,
    users: 0,
    quotaPolicies: 0,
    quotaAccounts: 0,
    quotaLedger: 0,
    providers: 0,
    models: 0,
    modelPrices: 0,
    conversations: 0,
    attachments: 0,
    messages: 0,
    messageParts: 0,
    generationJobs: 0,
    usageEvents: 0,
    usageDaily: 0,
    auditLogs: 0,
    errorEvents: 0,
  };
}

async function seedSettings(ctx: SeedContext): Promise<void> {
  for (const s of SEED_SETTINGS) {
    const res = await ctx.tx.client.query(
      `INSERT INTO system_settings (key, value, version, updated_at)
       VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [s.key, s.value],
    );
    addInserted(ctx, 'settings', res.rowCount);
  }
}

async function seedDivisions(ctx: SeedContext): Promise<void> {
  for (const div of SEED_DIVISIONS) {
    const res = await ctx.tx.client.query<{ id: string }>(
      `INSERT INTO divisions (id, name, external_ref, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET external_ref = EXCLUDED.external_ref
       RETURNING id`,
      [div.id, div.name, div.externalRef, div.createdAt],
    );
    const rowId = res.rows[0]?.id ?? div.id;
    ctx.divisionIdByName.set(div.name, rowId);
    addInserted(ctx, 'divisions', res.rowCount);
  }
}

async function seedUsers(ctx: SeedContext): Promise<void> {
  for (const u of SEED_USERS) {
    const divisionId = u.divisionName
      ? ctx.divisionIdByName.get(u.divisionName) ?? null
      : null;
    const res = await ctx.tx.client.query<{ id: string }>(
      `INSERT INTO users (
         id, email, display_name, password_hash, role, status,
         division_id, must_change_password, failed_login_attempts,
         created_at, updated_at, last_login_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
       ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET
         display_name = EXCLUDED.display_name,
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         division_id = EXCLUDED.division_id,
         last_login_at = EXCLUDED.last_login_at,
         updated_at = now()
       RETURNING id`,
      [
        u.id,
        u.email,
        u.displayName,
        ctx.defaultPasswordHash,
        u.role,
        u.status,
        divisionId,
        u.mustChangePassword,
        u.failedLoginAttempts,
        u.createdAt,
        u.lastLoginAt,
      ],
    );
    const rowId = res.rows[0]?.id ?? u.id;
    ctx.userIdByEmail.set(u.email, rowId);
    addInserted(ctx, 'users', res.rowCount);
  }
}

async function seedQuotaPolicies(ctx: SeedContext): Promise<void> {
  for (const qp of SEED_QUOTA_POLICIES) {
    const divisionId = qp.divisionName
      ? ctx.divisionIdByName.get(qp.divisionName) ?? null
      : null;
    const userId = qp.userEmail ? ctx.userIdByEmail.get(qp.userEmail) ?? null : null;
    const res = await ctx.tx.client.query(
      `INSERT INTO quota_policies (
         id, scope, division_id, user_id, monthly_tokens,
         max_input_tokens_per_request, max_output_tokens_per_request,
         max_concurrent_generations, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (scope, COALESCE(division_id, user_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET
         monthly_tokens = EXCLUDED.monthly_tokens,
         max_input_tokens_per_request = EXCLUDED.max_input_tokens_per_request,
         max_output_tokens_per_request = EXCLUDED.max_output_tokens_per_request,
         max_concurrent_generations = EXCLUDED.max_concurrent_generations,
         updated_at = now()`,
      [
        qp.id,
        qp.scope,
        divisionId,
        userId,
        qp.monthlyTokens,
        qp.maxInputTokensPerRequest,
        qp.maxOutputTokensPerRequest,
        qp.maxConcurrentGenerations,
      ],
    );
    addInserted(ctx, 'quotaPolicies', res.rowCount);
  }
}

async function seedQuotaAccounts(ctx: SeedContext): Promise<void> {
  const periodStart = new Date('2026-11-01T00:00:00Z');
  const periodEnd = new Date('2026-12-01T00:00:00Z');

  for (const u of SEED_USERS) {
    const userId = ctx.userIdByEmail.get(u.email);
    if (!userId) continue;

    const baseLimit =
      u.divisionName === 'Engineering' || u.divisionName === 'Data Science & AI'
        ? 5_000_000
        : 2_000_000;
    const usedTokens = u.email === 'sarah.chen@corp.example' ? 842_500 : 125_000;
    const accountId = `00000000-0000-7000-8010-${userId.slice(-12)}`;

    const res = await ctx.tx.client.query<{ id: string }>(
      `INSERT INTO quota_accounts (
         id, user_id, scope_type, scope_id, period_start, period_end,
         base_limit_tokens, adjustment_tokens, used_tokens, reserved_tokens,
         limits, updated_at
       )
       VALUES ($1, $2, 'total', NULL, $3, $4, $5, 0, $6, 0, $7::jsonb, now())
       ON CONFLICT (user_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start)
       DO UPDATE SET
         base_limit_tokens = EXCLUDED.base_limit_tokens,
         used_tokens = EXCLUDED.used_tokens,
         updated_at = now()
       RETURNING id`,
      [
        accountId,
        userId,
        periodStart,
        periodEnd,
        baseLimit,
        usedTokens,
        JSON.stringify({
          maxInputTokensPerRequest: 128000,
          maxOutputTokensPerRequest: 16384,
          maxConcurrentGenerations: 2,
        }),
      ],
    );
    const accId = res.rows[0]?.id ?? accountId;
    ctx.accountIdByUserId.set(userId, accId);
    addInserted(ctx, 'quotaAccounts', res.rowCount);

    await ctx.tx.client.query(
      `INSERT INTO quota_ledger (
         user_id, account_id, entry_type, tokens_delta, used_after, reserved_after,
         reason, created_at
       )
       SELECT $1, $2, 'period_open', 0, 0, 0, 'Monthly period initialization', $3
        WHERE NOT EXISTS (
          SELECT 1 FROM quota_ledger WHERE account_id = $2 AND entry_type = 'period_open'
        )`,
      [userId, accId, periodStart],
    );
    addInserted(ctx, 'quotaLedger', 1);
  }
}

async function seedProviders(ctx: SeedContext): Promise<void> {
  for (const [pIdx, provider] of SEED_PROVIDERS.entries()) {
    const providerId = `00000000-0000-7000-8011-${(pIdx + 1).toString().padStart(12, '0')}`;
    const res = await ctx.tx.client.query<{ id: string }>(
      `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status, config, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         adapter = EXCLUDED.adapter,
         secret_ref = EXCLUDED.secret_ref,
         status = EXCLUDED.status,
         config = EXCLUDED.config,
         updated_at = now()
       RETURNING id`,
      [
        providerId,
        provider.key,
        provider.displayName,
        provider.adapter,
        provider.secretRef,
        provider.status,
        JSON.stringify(provider.config),
      ],
    );
    const rowId = res.rows[0]?.id ?? providerId;
    ctx.providerIdByKey.set(provider.key, rowId);
    addInserted(ctx, 'providers', res.rowCount);
  }
}

async function seedModels(ctx: SeedContext): Promise<void> {
  for (const [mIdx, model] of SEED_MODELS.entries()) {
    const providerId = ctx.providerIdByKey.get(model.providerKey);
    if (!providerId) continue;

    const modelId = `00000000-0000-7000-8012-${(mIdx + 1).toString().padStart(12, '0')}`;
    const res = await ctx.tx.client.query<{ id: string }>(
      `INSERT INTO ai_models (
         id, provider_id, api_model_id, display_name, description, status,
         capabilities, context_window, max_output_tokens, default_max_output_tokens,
         quota_weight, sort_order, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, now())
       ON CONFLICT (provider_id, api_model_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         capabilities = EXCLUDED.capabilities,
         context_window = EXCLUDED.context_window,
         max_output_tokens = EXCLUDED.max_output_tokens,
         default_max_output_tokens = EXCLUDED.default_max_output_tokens,
         quota_weight = EXCLUDED.quota_weight,
         sort_order = EXCLUDED.sort_order,
         updated_at = now()
       RETURNING id`,
      [
        modelId,
        providerId,
        model.apiModelId,
        model.displayName,
        model.description,
        model.status,
        JSON.stringify(model.capabilities),
        model.contextWindow,
        model.maxOutputTokens,
        model.defaultMaxOutputTokens,
        model.quotaWeight,
        model.sortOrder,
      ],
    );
    const rowId = res.rows[0]?.id ?? modelId;
    ctx.modelIdByProviderAndApiModel.set(`${model.providerKey}:${model.apiModelId}`, rowId);
    addInserted(ctx, 'models', res.rowCount);
  }
}

async function seedModelPrices(ctx: SeedContext): Promise<void> {
  for (const price of SEED_MODEL_PRICES) {
    const modelId = ctx.modelIdByProviderAndApiModel.get(
      `${price.providerKey}:${price.apiModelId}`,
    );
    if (!modelId) continue;

    const priceId = `00000000-0000-7000-8013-${modelId.slice(-12)}`;
    const effectiveFrom = new Date('2026-01-01T00:00:00Z');
    const res = await ctx.tx.client.query(
      `INSERT INTO ai_model_prices (
         id, model_id, effective_from, input_micros_per_mtok,
         output_micros_per_mtok, cached_input_micros_per_mtok, currency
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'USD')
       ON CONFLICT (model_id, effective_from) DO UPDATE SET
         input_micros_per_mtok = EXCLUDED.input_micros_per_mtok,
         output_micros_per_mtok = EXCLUDED.output_micros_per_mtok,
         cached_input_micros_per_mtok = EXCLUDED.cached_input_micros_per_mtok`,
      [
        priceId,
        modelId,
        effectiveFrom,
        price.inputMicrosPerMtok,
        price.outputMicrosPerMtok,
        price.cachedInputMicrosPerMtok,
      ],
    );
    addInserted(ctx, 'modelPrices', res.rowCount);
  }
}

async function seedConversations(ctx: SeedContext): Promise<void> {
  for (const conv of buildSeedConversations()) {
    const userId = ctx.userIdByEmail.get(conv.userEmail);
    const modelId = ctx.modelIdByProviderAndApiModel.get(
      `${conv.providerKey}:${conv.apiModelId}`,
    );
    if (!userId || !modelId) continue;

    const res = await ctx.tx.client.query(
      `INSERT INTO conversations (
         id, user_id, model_id, title, message_count,
         last_message_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         message_count = EXCLUDED.message_count,
         last_message_at = EXCLUDED.last_message_at,
         updated_at = now()`,
      [
        conv.id,
        userId,
        modelId,
        conv.title,
        conv.messageCount,
        conv.lastMessageAt,
        conv.createdAt,
      ],
    );
    addInserted(ctx, 'conversations', res.rowCount);
  }
}

async function seedAttachments(ctx: SeedContext): Promise<void> {
  for (const att of SEED_ATTACHMENTS) {
    const ownerUserId = ctx.userIdByEmail.get(att.ownerEmail);
    if (!ownerUserId) continue;

    const expiresAt = new Date('2027-01-01T00:00:00Z');
    const res = await ctx.tx.client.query(
      `INSERT INTO attachments (
         id, owner_user_id, conversation_id, origin, kind,
         display_name, declared_mime, detected_mime, size_bytes,
         sha256, storage_provider, storage_key, status,
         width, height, page_count, expires_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (storage_key) DO NOTHING`,
      [
        att.id,
        ownerUserId,
        att.conversationId,
        att.origin,
        att.kind,
        att.displayName,
        att.declaredMime,
        att.detectedMime,
        att.sizeBytes,
        att.sha256,
        att.storageProvider,
        att.storageKey,
        att.status,
        att.width ?? null,
        att.height ?? null,
        att.pageCount ?? null,
        expiresAt,
        att.createdAt,
      ],
    );
    addInserted(ctx, 'attachments', res.rowCount);

    if (!att.extractionText) continue;

    await ctx.tx.client.query(
      `INSERT INTO file_extractions (
         file_id, status, extractor, text, char_count,
         token_estimate, truncated, page_count, created_at
       )
       VALUES ($1, 'done', 'anydoc', $2, $3, $4, false, $5, $6)
       ON CONFLICT (file_id) DO NOTHING`,
      [
        att.id,
        att.extractionText,
        att.charCount ?? att.extractionText.length,
        att.tokenEstimate ?? 100,
        att.pageCount ?? null,
        att.createdAt,
      ],
    );
  }
}

async function seedMessageParts(ctx: SeedContext, msg: SeedMessage): Promise<void> {
  if (msg.fileId) {
    await ctx.tx.client.query(
      `INSERT INTO message_parts (
         id, message_id, position, type, status, file_id, created_at, updated_at
       )
       VALUES ($1, $2, 0, 'document', 'complete', $3, $4, $4)
       ON CONFLICT (message_id, position) DO NOTHING`,
      [`00000000-0000-7000-8005-${msg.id.slice(-10)}01`, msg.id, msg.fileId, msg.createdAt],
    );
    addInserted(ctx, 'messageParts', 1);

    await ctx.tx.client.query(
      `INSERT INTO message_parts (
         id, message_id, position, type, status, text_content, created_at, updated_at
       )
       VALUES ($1, $2, 1, 'text', 'complete', $3, $4, $4)
       ON CONFLICT (message_id, position) DO NOTHING`,
      [`00000000-0000-7000-8005-${msg.id.slice(-10)}02`, msg.id, msg.textContent, msg.createdAt],
    );
    addInserted(ctx, 'messageParts', 1);
    return;
  }

  await ctx.tx.client.query(
    `INSERT INTO message_parts (
       id, message_id, position, type, status, text_content, created_at, updated_at
     )
     VALUES ($1, $2, 0, 'text', 'complete', $3, $4, $4)
     ON CONFLICT (message_id, position) DO NOTHING`,
    [`00000000-0000-7000-8005-${msg.id.slice(-10)}00`, msg.id, msg.textContent, msg.createdAt],
  );
  addInserted(ctx, 'messageParts', 1);
}

async function seedGenerationUsage(ctx: SeedContext, msg: SeedMessage): Promise<void> {
  const jobId = `00000000-0000-7000-8007-${msg.id.slice(-12)}`;
  const requestId = `req_gen_${msg.id.slice(-12)}`;
  const userId = ctx.userIdByEmail.get('sarah.chen@corp.example');
  const modelId = ctx.modelIdByProviderAndApiModel.get('openai:gpt-4o');
  const providerId = ctx.providerIdByKey.get('openai');
  const divisionId = ctx.divisionIdByName.get('Engineering');
  const accountId = userId ? ctx.accountIdByUserId.get(userId) : null;

  if (!userId || !modelId || !providerId || !accountId || !divisionId) return;

  const genRes = await ctx.tx.client.query(
    `INSERT INTO generation_jobs (
       id, request_id, user_id, conversation_id, assistant_message_id,
       model_id, provider_id, status, started_at, finished_at,
       est_input_tokens, max_output_tokens, context_info, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10, 4096, $11::jsonb, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      jobId,
      requestId,
      userId,
      msg.conversationId,
      msg.id,
      modelId,
      providerId,
      msg.createdAt,
      msg.completedAt,
      msg.estInputTokens ?? 500,
      JSON.stringify({ durationMs: msg.durationMs ?? 1400 }),
    ],
  );
  addInserted(ctx, 'generationJobs', genRes.rowCount);

  await ctx.tx.client.query(
    `INSERT INTO quota_reservations (
       id, generation_id, user_id, account_id, reserved_tokens,
       settled_tokens, status, expires_at, created_at, finalized_at
     )
     VALUES ($1, $2, $3, $4, 4096, $5, 'settled', $6, $7, $8)
     ON CONFLICT (generation_id) DO NOTHING`,
    [
      `00000000-0000-7000-8014-${msg.id.slice(-12)}`,
      jobId,
      userId,
      accountId,
      (msg.estInputTokens ?? 500) + (msg.estOutputTokens ?? 300),
      new Date(msg.completedAt.getTime() + 600_000),
      msg.createdAt,
      msg.completedAt,
    ],
  );

  const inTokens = msg.estInputTokens ?? 500;
  const outTokens = msg.estOutputTokens ?? 300;
  const qTokens = inTokens + outTokens;
  const costMicros = Math.round(inTokens * 2.5 + outTokens * 10.0);

  const useRes = await ctx.tx.client.query(
    `INSERT INTO usage_events (
       id, generation_id, user_id, division_id, provider_id,
       model_id, account_id, input_tokens, output_tokens, quota_tokens,
       usage_source, est_cost_micros, cost_currency, outcome,
       duration_ms, time_to_first_token_ms, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'provider', $11, 'USD', 'completed', $12, 180, $13)
     ON CONFLICT (generation_id) DO NOTHING`,
    [
      `00000000-0000-7000-8008-${msg.id.slice(-12)}`,
      jobId,
      userId,
      divisionId,
      providerId,
      modelId,
      accountId,
      inTokens,
      outTokens,
      qTokens,
      costMicros,
      msg.durationMs ?? 1400,
      msg.completedAt,
    ],
  );
  addInserted(ctx, 'usageEvents', useRes.rowCount);
}

async function seedMessages(ctx: SeedContext): Promise<void> {
  for (const msg of buildSeedMessages()) {
    const res = await ctx.tx.client.query(
      `INSERT INTO messages (
         id, conversation_id, seq, role, status, finish_reason,
         created_at, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (conversation_id, seq) DO NOTHING`,
      [
        msg.id,
        msg.conversationId,
        msg.seq,
        msg.role,
        msg.status,
        msg.finishReason ?? null,
        msg.createdAt,
        msg.completedAt,
      ],
    );
    addInserted(ctx, 'messages', res.rowCount);

    await seedMessageParts(ctx, msg);

    if (msg.role === 'assistant') {
      await seedGenerationUsage(ctx, msg);
    }
  }
}

async function seedDailyUsage(ctx: SeedContext): Promise<void> {
  for (const du of buildSeedDailyUsage()) {
    const userId = ctx.userIdByEmail.get(du.userEmail);
    const divisionId = ctx.divisionIdByName.get(du.divisionName);
    const providerId = ctx.providerIdByKey.get(du.providerKey);
    const modelId = ctx.modelIdByProviderAndApiModel.get(
      `${du.providerKey}:${du.apiModelId}`,
    );
    if (!userId || !divisionId || !providerId || !modelId) continue;

    const res = await ctx.tx.client.query(
      `INSERT INTO usage_daily (
         day, user_id, division_id, provider_id, model_id,
         requests, failed_requests, provider_sourced_requests,
         input_tokens, output_tokens, quota_tokens, est_cost_micros
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (day, user_id, model_id) DO UPDATE SET
         requests = EXCLUDED.requests,
         failed_requests = EXCLUDED.failed_requests,
         provider_sourced_requests = EXCLUDED.provider_sourced_requests,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         quota_tokens = EXCLUDED.quota_tokens,
         est_cost_micros = EXCLUDED.est_cost_micros`,
      [
        du.day,
        userId,
        divisionId,
        providerId,
        modelId,
        du.requests,
        du.failedRequests,
        du.requests - du.failedRequests,
        du.inputTokens,
        du.outputTokens,
        du.quotaTokens,
        du.estCostMicros,
      ],
    );
    addInserted(ctx, 'usageDaily', res.rowCount);
  }
}

async function seedAuditLogs(ctx: SeedContext): Promise<void> {
  for (const log of buildSeedAuditLogs()) {
    const actorUserId = ctx.userIdByEmail.get(log.actorEmail) ?? null;
    const check = await ctx.tx.client.query(
      `SELECT 1 FROM audit_logs WHERE request_id = $1 LIMIT 1`,
      [log.requestId],
    );
    if (check.rows.length > 0) continue;

    await ctx.tx.client.query(
      `INSERT INTO audit_logs (
         actor_user_id, action, target_type, target_id, before, after,
         request_id, ip, created_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::inet, $9)`,
      [
        actorUserId,
        log.action,
        log.targetType,
        log.targetId,
        log.before ? JSON.stringify(log.before) : null,
        log.after ? JSON.stringify(log.after) : null,
        log.requestId,
        log.ip,
        log.createdAt,
      ],
    );
    addInserted(ctx, 'auditLogs', 1);
  }
}

async function seedErrorEvents(ctx: SeedContext): Promise<void> {
  for (const err of buildSeedErrorEvents()) {
    const providerId = err.providerKey
      ? ctx.providerIdByKey.get(err.providerKey) ?? null
      : null;
    const modelId =
      err.providerKey && err.apiModelId
        ? ctx.modelIdByProviderAndApiModel.get(`${err.providerKey}:${err.apiModelId}`) ?? null
        : null;

    const check = await ctx.tx.client.query(
      `SELECT 1 FROM error_events WHERE request_id = $1 LIMIT 1`,
      [err.requestId],
    );
    if (check.rows.length > 0) continue;

    await ctx.tx.client.query(
      `INSERT INTO error_events (
         request_id, component, category, provider_id, model_id,
         message, context, occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        err.requestId,
        err.component,
        err.category,
        providerId,
        modelId,
        err.message,
        JSON.stringify(err.context),
        err.occurredAt,
      ],
    );
    addInserted(ctx, 'errorEvents', 1);
  }
}

/**
 * Idempotent: re-running updates or skips existing records safely. Refuses in production.
 */
export async function runExampleSeed(): Promise<SeedResult> {
  const config = getConfig();
  if (config.NODE_ENV === 'production') {
    throw new Error('db:seed:example must never run against production.');
  }

  if (!(await registryTablesPresent())) {
    return {
      seeded: false,
      reason: 'registry tables not present yet',
      inserted: {},
    };
  }

  const inserted = emptyInsertedCounts();

  // Pre-compute argon2id hash once for Passw0rd!2026 to speed up insertion
  const defaultPasswordHash = await Bun.password.hash('Passw0rd!2026', ARGON2_SEED_OPTIONS);

  await withTransaction(async (tx) => {
    const ctx: SeedContext = {
      tx,
      inserted,
      defaultPasswordHash,
      divisionIdByName: new Map(),
      userIdByEmail: new Map(),
      accountIdByUserId: new Map(),
      providerIdByKey: new Map(),
      modelIdByProviderAndApiModel: new Map(),
    };

    await seedSettings(ctx);
    await seedDivisions(ctx);
    await seedUsers(ctx);
    await seedQuotaPolicies(ctx);
    await seedQuotaAccounts(ctx);
    await seedProviders(ctx);
    await seedModels(ctx);
    await seedModelPrices(ctx);
    await seedConversations(ctx);
    await seedAttachments(ctx);
    await seedMessages(ctx);
    await seedDailyUsage(ctx);
    await seedAuditLogs(ctx);
    await seedErrorEvents(ctx);
  });

  return {
    seeded: true,
    reason: `seeded ${inserted.divisions ?? 0} division(s), ${inserted.users ?? 0} user(s), ${inserted.providers ?? 0} provider(s), ${inserted.models ?? 0} model(s), ${inserted.conversations ?? 0} conversation(s), ${inserted.messages ?? 0} message(s), ${inserted.auditLogs ?? 0} audit log(s), ${inserted.errorEvents ?? 0} error event(s), ${inserted.usageDaily ?? 0} daily usage row(s)`,
    inserted,
  };
}

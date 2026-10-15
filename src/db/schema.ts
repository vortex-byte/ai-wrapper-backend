import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const divisions = pgTable('divisions', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  externalRef: text('external_ref'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordUpdatedAt: timestamptz('password_updated_at')
      .notNull()
      .default(sql`now()`),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    divisionId: uuid('division_id').references(() => divisions.id),
    idpSubject: text('idp_subject'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamptz('last_login_at'),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    uniqueIndex('users_idp_subject_uq')
      .on(table.idpSubject)
      .where(sql`${table.idpSubject} IS NOT NULL`),
  ],
);

export const sessions = pgTable('sessions', {
  id: char('id', { length: 64 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  lastSeenAt: timestamptz('last_seen_at')
    .notNull()
    .default(sql`now()`),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  rotatedFrom: char('rotated_from', { length: 64 }),
  ip: inet('ip'),
  userAgentHash: text('user_agent_hash'),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  requestId: text('request_id'),
  ip: inet('ip'),
  userAgentHash: text('user_agent_hash'),
  prevHash: char('prev_hash', { length: 64 }),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const errorEvents = pgTable('error_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  occurredAt: timestamptz('occurred_at')
    .notNull()
    .default(sql`now()`),
  requestId: text('request_id'),
  component: text('component').notNull(),
  category: text('category').notNull(),
  providerId: uuid('provider_id'),
  modelId: uuid('model_id'),
  generationId: uuid('generation_id'),
  message: text('message').notNull(),
  context: jsonb('context').notNull().default({}),
});

export const aiProviders = pgTable('ai_providers', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  displayName: text('display_name').notNull(),
  adapter: text('adapter').notNull(),
  baseUrl: text('base_url'),
  secretRef: text('secret_ref').notNull(),
  status: text('status').notNull().default('active'),
  config: jsonb('config').notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const aiModels = pgTable('ai_models', {
  id: uuid('id').primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => aiProviders.id),
  key: text('key').notNull(),
  apiModelId: text('api_model_id').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('disabled'),
  capabilities: jsonb('capabilities').notNull(),
  contextWindow: integer('context_window').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  defaultMaxOutputTokens: integer('default_max_output_tokens').notNull(),
  quotaWeight: numeric('quota_weight', { precision: 8, scale: 3 }).notNull().default('1.000'),
  config: jsonb('config').notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const aiModelPrices = pgTable('ai_model_prices', {
  id: uuid('id').primaryKey(),
  modelId: uuid('model_id')
    .notNull()
    .references(() => aiModels.id, { onDelete: 'cascade' }),
  effectiveFrom: timestamptz('effective_from').notNull(),
  inputMicrosPerMtok: bigint('input_micros_per_mtok', { mode: 'number' }).notNull(),
  outputMicrosPerMtok: bigint('output_micros_per_mtok', { mode: 'number' }).notNull(),
  cachedInputMicrosPerMtok: bigint('cached_input_micros_per_mtok', { mode: 'number' }),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  modelId: uuid('model_id')
    .notNull()
    .references(() => aiModels.id),
  title: text('title').notNull().default('New conversation'),
  messageCount: integer('message_count').notNull().default(0),
  lastMessageAt: timestamptz('last_message_at'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
  deletedAt: timestamptz('deleted_at'),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  role: text('role').notNull(),
  status: text('status').notNull(),
  finishReason: text('finish_reason'),
  supersededBy: uuid('superseded_by'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  completedAt: timestamptz('completed_at'),
});

export const messageParts = pgTable('message_parts', {
  id: uuid('id').primaryKey(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('complete'),
  textContent: text('text_content'),
  data: jsonb('data').notNull().default({}),
  fileId: uuid('file_id'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

/**
 * The generation execution and job record. One live generation per conversation
 * is enforced by a database partial unique index.
 */
export const generationJobs = pgTable('generation_jobs', {
  id: uuid('id').primaryKey(),
  requestId: text('request_id').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  assistantMessageId: uuid('assistant_message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  modelId: uuid('model_id')
    .notNull()
    .references(() => aiModels.id),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => aiProviders.id),
  status: text('status').notNull(),
  runnerId: text('runner_id'),
  cancelReason: text('cancel_reason'),
  startedAt: timestamptz('started_at'),
  heartbeatAt: timestamptz('heartbeat_at'),
  finishedAt: timestamptz('finished_at'),
  lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull().default(0),
  estInputTokens: integer('est_input_tokens'),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  modelLock: jsonb('model_lock').notNull().default({}),
  options: jsonb('options').notNull().default({}),
  contextInfo: jsonb('context_info').notNull().default({}),
  errorCategory: text('error_category'),
  errorDetail: jsonb('error_detail'),
  providerRequestId: text('provider_request_id'),
  providerLatencyMs: integer('provider_latency_ms'),
  attempt: integer('attempt').notNull().default(1),
  supersededBy: uuid('superseded_by').references((): AnyPgColumn => generationJobs.id),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const quotaPolicies = pgTable('quota_policies', {
  id: uuid('id').primaryKey(),
  scope: text('scope').notNull(),
  divisionId: uuid('division_id').references(() => divisions.id),
  userId: uuid('user_id').references(() => users.id),
  monthlyTokens: bigint('monthly_tokens', { mode: 'number' }),
  maxInputTokensPerRequest: integer('max_input_tokens_per_request'),
  maxOutputTokensPerRequest: integer('max_output_tokens_per_request'),
  maxConcurrentGenerations: integer('max_concurrent_generations'),
  allowedModelIds: uuid('allowed_model_ids').array(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const quotaAccounts = pgTable('quota_accounts', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  scopeType: text('scope_type').notNull().default('total'),
  scopeId: uuid('scope_id'),
  periodStart: timestamptz('period_start').notNull(),
  periodEnd: timestamptz('period_end').notNull(),
  baseLimitTokens: bigint('base_limit_tokens', { mode: 'number' }).notNull(),
  adjustmentTokens: bigint('adjustment_tokens', { mode: 'number' }).notNull().default(0),
  usedTokens: bigint('used_tokens', { mode: 'number' }).notNull().default(0),
  reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
  limits: jsonb('limits').notNull().default({}),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const quotaReservations = pgTable('quota_reservations', {
  id: uuid('id').primaryKey(),
  generationId: uuid('generation_id')
    .notNull()
    .unique()
    .references(() => generationJobs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  accountId: uuid('account_id')
    .notNull()
    .references(() => quotaAccounts.id),
  reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull(),
  settledTokens: bigint('settled_tokens', { mode: 'number' }),
  status: text('status').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  finalizedAt: timestamptz('finalized_at'),
});

export const quotaLedger = pgTable(
  'quota_ledger',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => quotaAccounts.id),
    generationId: uuid('generation_id').references(() => generationJobs.id, {
      onDelete: 'set null',
    }),
    entryType: text('entry_type').notNull(),
    tokensDelta: bigint('tokens_delta', { mode: 'number' }).notNull().default(0),
    usedAfter: bigint('used_after', { mode: 'number' }).notNull(),
    reservedAfter: bigint('reserved_after', { mode: 'number' }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    reason: text('reason'),
    requestId: text('request_id'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index('quota_ledger_user_time_idx').on(table.userId, table.createdAt)],
);

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey(),
  generationId: uuid('generation_id')
    .notNull()
    .unique()
    .references(() => generationJobs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  divisionId: uuid('division_id').references(() => divisions.id),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => aiProviders.id),
  modelId: uuid('model_id')
    .notNull()
    .references(() => aiModels.id),
  accountId: uuid('account_id')
    .notNull()
    .references(() => quotaAccounts.id),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedInputTokens: integer('cached_input_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  quotaTokens: bigint('quota_tokens', { mode: 'number' }).notNull(),
  overshootTokens: bigint('overshoot_tokens', { mode: 'number' }).notNull().default(0),
  usageSource: text('usage_source').notNull(),
  estCostMicros: bigint('est_cost_micros', { mode: 'number' }),
  costCurrency: char('cost_currency', { length: 3 }).notNull().default('USD'),
  outcome: text('outcome').notNull(),
  errorCategory: text('error_category'),
  durationMs: integer('duration_ms'),
  timeToFirstTokenMs: integer('time_to_first_token_ms'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const usageDaily = pgTable(
  'usage_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    userId: uuid('user_id').notNull(),
    divisionId: uuid('division_id'),
    providerId: uuid('provider_id').notNull(),
    modelId: uuid('model_id').notNull(),
    requests: integer('requests').notNull(),
    failedRequests: integer('failed_requests').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    quotaTokens: bigint('quota_tokens', { mode: 'number' }).notNull(),
    estCostMicros: bigint('est_cost_micros', { mode: 'number' }),
  },
  (table) => [primaryKey({ columns: [table.day, table.userId, table.modelId] })],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('queued'),
  runAt: timestamptz('run_at')
    .notNull()
    .default(sql`now()`),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lockedBy: text('locked_by'),
  lockedAt: timestamptz('locked_at'),
  lastError: text('last_error'),
  dedupeKey: text('dedupe_key').unique(),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  finishedAt: timestamptz('finished_at'),
});

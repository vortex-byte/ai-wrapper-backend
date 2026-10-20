import type { Config } from './config/index.ts';
import { and, eq, isNull } from 'drizzle-orm';
import { runDb } from './db/client.ts';
import { users as usersTable } from './db/schema.ts';
import type { AuthService } from './auth/application/auth-service.ts';
import { createAuthService } from './auth/application/auth-service.ts';
import { BunPasswordHasher } from './auth/infrastructure/bun-password-hasher.ts';
import { DrizzleSessionRepository } from './auth/infrastructure/drizzle-session-repository.ts';
import { DrizzleUserRepository } from './auth/infrastructure/drizzle-user-repository.ts';
import { DrizzleAuditLogRepository } from './audit/infrastructure/drizzle-audit-log-repository.ts';
import { systemClock, uuidv7Generator } from './clock/index.ts';
import type { AdminService } from './admin/application/admin-service.ts';
import { createAdminService } from './admin/application/admin-service.ts';
import { DrizzleDivisionRepository } from './admin/infrastructure/drizzle-division-repository.ts';
import type { RateLimiter } from './http/ports/rate-limiter.ts';
import { MemoryRateLimiter } from './http/infrastructure/memory-rate-limiter.ts';
import type { AuditLogRepository } from './audit/ports/audit-log-repository.ts';

import type { ProviderRegistry } from './providers/ports/provider-registry.ts';
import { createDefaultProviderRegistry } from './providers/infrastructure/register-adapters.ts';
import { DrizzleRegistryRepository } from './providers/infrastructure/drizzle-registry-repository.ts';
import { CachedModelRegistry } from './providers/infrastructure/cached-registry.ts';
import { EnvSecretResolver } from './providers/ports/secret-resolver.ts';
import type { ModelRegistry } from './providers/ports/model-registry.ts';
import type { RegistryAdminService } from './providers/application/registry-admin-service.ts';
import { createRegistryAdminService } from './providers/application/registry-admin-service.ts';

import type { ConversationService } from './conversations/application/conversation-service.ts';
import { createConversationService } from './conversations/application/conversation-service.ts';
import { DrizzleConversationRepository } from './conversations/infrastructure/drizzle-conversation-repository.ts';

import type { SettingsService } from './settings/application/settings-service.ts';
import { createSettingsService } from './settings/application/settings-service.ts';
import { DrizzleSettingsRepository } from './settings/infrastructure/drizzle-settings-repository.ts';

import type { SendService } from './generations/application/send-service.ts';
import { createSendService } from './generations/application/send-service.ts';
import { DrizzleGenerationRepository } from './generations/infrastructure/drizzle-generation-repository.ts';
import { RealQuota } from './quota/infrastructure/real-quota.ts';
import { DrizzleQuotaAccountRepository } from './quota/infrastructure/drizzle-quota-account-repository.ts';
import { DrizzleQuotaPolicyRepository } from './quota/infrastructure/drizzle-quota-policy-repository.ts';
import { DrizzleUsageRepository } from './quota/infrastructure/drizzle-usage-repository.ts';
import { QuotaService } from './quota/application/quota-service.ts';
import { UsageService } from './quota/application/usage-service.ts';
import type { QuotaPort } from './generations/ports/quota-port.ts';
import type { QuotaService as QuotaServiceType } from './quota/application/quota-service.ts';
import type { UsageService as UsageServiceType } from './quota/application/usage-service.ts';
import type { ErrorEventWriter } from './generations/ports/error-event-writer.ts';
import { DrizzleErrorEventWriter } from './generations/infrastructure/drizzle-error-event-writer.ts';
import { createGenerationMetrics, type GenerationMetrics } from './observability/metrics.ts';
import { GenerationManager } from './orchestrator/index.ts';

import type { ConversationRepository } from './conversations/ports/conversation-repository.ts';
import type { GenerationRepository } from './generations/ports/generation-repository.ts';
import { Finalizer } from './generations/application/finalizer.ts';

import { LocalStorageProvider } from './storage/index.ts';
import { ArtifactSink } from './artifactsink/index.ts';
import {
  GENERATED_FILE_RETENTION_DAYS,
  MAX_GENERATED_ARTIFACT_BYTES,
} from './artifactsink/index.ts';
import { DrizzleAttachmentRepository } from './attachments/infrastructure/drizzle-attachment-repository.ts';
import { AttachmentService } from './attachments/application/attachment-service.ts';
import type { AttachmentService as AttachmentServiceType } from './attachments/application/attachment-service.ts';
import {
  createAttachmentsExpiryHandler,
  createAttachmentsOrphanHandler,
} from './attachments/application/expiry-handler.ts';
import { createStorageReconcileHandler } from './attachments/application/storage-reconcile-handler.ts';

import type { JobQueue } from './jobs/ports/job-queue.ts';
import { DrizzleJobQueue } from './jobs/infrastructure/drizzle-job-queue.ts';
import { JobRunner } from './jobs/application/job-runner.ts';
import { Scheduler } from './jobs/application/scheduler.ts';
import { createReaperHandler } from './jobs/application/handlers/reaper-handler.ts';
import {
  createIdempotencyPurgeHandler,
  createSessionsPurgeHandler,
} from './jobs/application/handlers/purge-handler.ts';
import { createQuotaReaperHandler } from './jobs/application/handlers/quota-reaper-handler.ts';
import { createReconciliationHandler } from './jobs/application/handlers/reconciliation-handler.ts';
import { createUsageRollupHandler } from './jobs/application/handlers/usage-rollup-handler.ts';
import { createPrecreatePeriodsHandler } from './jobs/application/handlers/precreate-periods-handler.ts';

export interface Services {
  readonly auth: AuthService;
  readonly admin: AdminService;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLogRepository;
  readonly providers: ProviderRegistry;
  readonly registry: ModelRegistry;
  readonly registryAdmin: RegistryAdminService;
  readonly conversations: ConversationService;
  readonly conversationRepository: ConversationRepository;
  readonly settings: SettingsService;
  readonly send: SendService;
  readonly generationRepository: GenerationRepository;
  readonly errorEvents: ErrorEventWriter;
  readonly metrics: GenerationMetrics;
  readonly orchestrator: GenerationManager;
  readonly finalizer: Finalizer;
  readonly jobQueue: JobQueue;
  readonly jobRunner: JobRunner;
  readonly scheduler: Scheduler;
  readonly reaperHandler: () => Promise<{ reapedCount: number }>;
  readonly quota: QuotaPort;
  readonly quotaService: QuotaServiceType;
  readonly usageService: UsageServiceType;
  readonly attachments: AttachmentServiceType;
  readonly storage: LocalStorageProvider;
}

export function createServices(config: Config): Services {
  const users = new DrizzleUserRepository();
  const sessions = new DrizzleSessionRepository();
  const divisions = new DrizzleDivisionRepository();
  const audit = new DrizzleAuditLogRepository();
  const hasher = new BunPasswordHasher();
  const rateLimiter = new MemoryRateLimiter(systemClock);
  const providers = createDefaultProviderRegistry();
  const registryRepository = new DrizzleRegistryRepository();
  const secrets = new EnvSecretResolver(process.env);
  const registry = new CachedModelRegistry({
    repository: registryRepository,
    secrets,
    clock: systemClock,
  });

  const auth = createAuthService({
    users,
    sessions,
    hasher,
    audit,
    clock: systemClock,
    lockout: {
      maxFailures: config.LOGIN_MAX_FAILURES,
      lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
    },
    sessionPolicy: {
      idleMinutes: config.SESSION_IDLE_MINUTES,
      absoluteMinutes: config.SESSION_ABSOLUTE_MINUTES,
    },
    passwordPolicy: { minLength: config.PASSWORD_MIN_LENGTH },
  });

  const admin = createAdminService({
    users,
    divisions,
    sessions,
    hasher,
    audit,
    clock: systemClock,
    idGen: uuidv7Generator,
    passwordPolicy: { minLength: config.PASSWORD_MIN_LENGTH },
  });

  const registryAdmin = createRegistryAdminService({
    repository: registryRepository,
    registry,
    adapters: providers,
    secrets,
    audit,
    clock: systemClock,
    idGen: uuidv7Generator,
  });

  const conversationRepository = new DrizzleConversationRepository();
  const conversations = createConversationService({
    repository: conversationRepository,
    registry,
    clock: systemClock,
    idGen: uuidv7Generator,
  });

  const settingsRepository = new DrizzleSettingsRepository();
  const settings = createSettingsService({
    repository: settingsRepository,
    audit,
  });

  const errorEvents = new DrizzleErrorEventWriter();
  const metrics = createGenerationMetrics();
  const generationRepository = new DrizzleGenerationRepository();

  const storage = new LocalStorageProvider(config.STORAGE_LOCAL_ROOT);
  const attachmentRepository = new DrizzleAttachmentRepository();
  const attachments = new AttachmentService(
    config,
    storage,
    attachmentRepository,
    conversationRepository,
    systemClock,
    uuidv7Generator,
  );
  const artifactSink = new ArtifactSink({
    storage,
    attachments: attachmentRepository,
    conversations: conversationRepository,
    clock: systemClock,
    idGen: uuidv7Generator,
    retentionDays: GENERATED_FILE_RETENTION_DAYS,
    maxBytes: MAX_GENERATED_ARTIFACT_BYTES,
  });

  const quotaAccountsRepo = new DrizzleQuotaAccountRepository();
  const quotaPoliciesRepo = new DrizzleQuotaPolicyRepository();
  const usageRepo = new DrizzleUsageRepository();
  const realQuota = new RealQuota({
    accounts: quotaAccountsRepo,
    policies: quotaPoliciesRepo,
    usage: usageRepo,
    clock: systemClock,
    idGen: uuidv7Generator,
    quotaTimezone: config.QUOTA_TIMEZONE,
  });
  const quota: QuotaPort = realQuota;
  const quotaService: QuotaServiceType = new QuotaService({
    accounts: quotaAccountsRepo,
    policies: quotaPoliciesRepo,
    idGen: () => uuidv7Generator.uuidv7(),
    quotaTimezone: config.QUOTA_TIMEZONE,
  });
  const usageService: UsageServiceType = new UsageService({ usage: usageRepo });

  const finalizer = new Finalizer({
    generations: generationRepository,
    conversations: conversationRepository,
    quota,
    errorEvents,
    clock: systemClock,
  });

  const orchestrator = new GenerationManager({
    providerRegistry: providers,
    clock: systemClock,
    idGen: uuidv7Generator,
    config,
    metrics,
    finalizer,
    generationRepo: generationRepository,
    conversationRepo: conversationRepository,
    artifactSink,
  });

  const send = createSendService({
    conversations: conversationRepository,
    generations: generationRepository,
    quota,
    registry,
    clock: systemClock,
    idGen: uuidv7Generator,
    config,
    orchestrator,
    attachments,
    attachmentRepo: attachmentRepository,
  });

  const jobQueue = new DrizzleJobQueue(systemClock, uuidv7Generator);

  const attachmentsExpiryHandler = createAttachmentsExpiryHandler({
    attachments: attachmentRepository,
    storage,
    clock: systemClock,
  });
  const attachmentsOrphanHandler = createAttachmentsOrphanHandler({
    attachments: attachmentRepository,
    storage,
    clock: systemClock,
  });
  const storageReconcileHandler = createStorageReconcileHandler({
    attachments: attachmentRepository,
    storage,
    clock: systemClock,
  });

  const runnerId = `runner-${uuidv7Generator.uuidv7()}`;
  const jobRunner = new JobRunner(jobQueue, runnerId);
  const scheduler = new Scheduler(jobQueue);

  const reaperHandler = createReaperHandler({ finalizer, generations: generationRepository });
  const idempotencyPurgeHandler = createIdempotencyPurgeHandler();
  const sessionsPurgeHandler = createSessionsPurgeHandler();

  const quotaReaperHandler = createQuotaReaperHandler({
    accounts: quotaAccountsRepo,
    finalizer,
    clock: systemClock,
  });
  const reconciliationHandler = createReconciliationHandler({
    accounts: quotaAccountsRepo,
    clock: systemClock,
  });
  const usageRollup = createUsageRollupHandler({ usage: usageRepo });
  const precreatePeriodsHandler = createPrecreatePeriodsHandler({
    accounts: quotaAccountsRepo,
    userIds: async () => {
      const rows = await runDb()
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.status, 'active'), isNull(usersTable.deletedAt)));
      return rows.map((row) => row.id);
    },
    clock: systemClock,
    idGen: uuidv7Generator,
    quotaTimezone: config.QUOTA_TIMEZONE,
    resolvePolicyForUser: (userId, tx) => realQuota.resolvePolicyForUser(userId, tx),
  });

  jobRunner.registerHandler('generation.reaper', async () => reaperHandler());
  jobRunner.registerHandler('idempotency.purge', async () => idempotencyPurgeHandler());
  jobRunner.registerHandler('sessions.purge', async () => sessionsPurgeHandler());
  jobRunner.registerHandler('quota.reservations.reaper', async () => quotaReaperHandler());
  jobRunner.registerHandler('quota.reconcile', async () => reconciliationHandler());
  jobRunner.registerHandler('usage.rollup.incremental', async () => usageRollup.incremental());
  jobRunner.registerHandler('usage.rollup.nightly', async () => usageRollup.nightly());
  jobRunner.registerHandler('quota.precreate_periods', async () => precreatePeriodsHandler());
  jobRunner.registerHandler('attachments.expire', async () => attachmentsExpiryHandler());
  jobRunner.registerHandler('attachments.purge_orphans', async () => attachmentsOrphanHandler());
  jobRunner.registerHandler('storage.reconcile', async () => storageReconcileHandler());

  return {
    auth,
    admin,
    rateLimiter,
    audit,
    providers,
    registry,
    registryAdmin,
    conversations,
    conversationRepository,
    settings,
    send,
    generationRepository,
    errorEvents,
    metrics,
    orchestrator,
    finalizer,
    jobQueue,
    jobRunner,
    scheduler,
    reaperHandler,
    quota,
    quotaService,
    usageService,
    attachments,
    storage,
  };
}

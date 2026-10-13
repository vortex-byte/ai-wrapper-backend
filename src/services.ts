import type { Config } from './config/index.ts';
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
import { NoopQuota } from './generations/infrastructure/noop-quota.ts';
import type { ErrorEventWriter } from './generations/ports/error-event-writer.ts';
import { DrizzleErrorEventWriter } from './generations/infrastructure/drizzle-error-event-writer.ts';
import { createGenerationMetrics, type GenerationMetrics } from './observability/metrics.ts';
import { GenerationManager } from './orchestrator/index.ts';

import type { ConversationRepository } from './conversations/ports/conversation-repository.ts';
import type { GenerationRepository } from './generations/ports/generation-repository.ts';
import { Finalizer } from './generations/application/finalizer.ts';

import type { JobQueue } from './jobs/ports/job-queue.ts';
import { DrizzleJobQueue } from './jobs/infrastructure/drizzle-job-queue.ts';
import { JobRunner } from './jobs/application/job-runner.ts';
import { Scheduler } from './jobs/application/scheduler.ts';
import { createReaperHandler } from './jobs/application/handlers/reaper-handler.ts';
import {
  createIdempotencyPurgeHandler,
  createSessionsPurgeHandler,
} from './jobs/application/handlers/purge-handler.ts';

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
  const quota = new NoopQuota();
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
  });

  const jobQueue = new DrizzleJobQueue(systemClock, uuidv7Generator);
  const runnerId = `runner-${uuidv7Generator.uuidv7()}`;
  const jobRunner = new JobRunner(jobQueue, runnerId);
  const scheduler = new Scheduler(jobQueue);

  const reaperHandler = createReaperHandler({ finalizer, generations: generationRepository });
  const idempotencyPurgeHandler = createIdempotencyPurgeHandler();
  const sessionsPurgeHandler = createSessionsPurgeHandler();

  jobRunner.registerHandler('generation.reaper', async () => reaperHandler());
  jobRunner.registerHandler('idempotency.purge', async () => idempotencyPurgeHandler());
  jobRunner.registerHandler('sessions.purge', async () => sessionsPurgeHandler());

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
  };
}

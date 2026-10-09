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
import { InMemoryProviderRegistry } from './providers/infrastructure/registry.ts';
import { FakeProvider } from './providers/infrastructure/fake/fake-provider.ts';

export interface Services {
  readonly auth: AuthService;
  readonly admin: AdminService;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLogRepository;
  readonly providers: ProviderRegistry;
}

export function createServices(config: Config): Services {
  const users = new DrizzleUserRepository();
  const sessions = new DrizzleSessionRepository();
  const divisions = new DrizzleDivisionRepository();
  const audit = new DrizzleAuditLogRepository();
  const hasher = new BunPasswordHasher();
  const rateLimiter = new MemoryRateLimiter(systemClock);

  const providers = new InMemoryProviderRegistry();
  providers.register(new FakeProvider());

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

  return { auth, admin, rateLimiter, audit, providers };
}

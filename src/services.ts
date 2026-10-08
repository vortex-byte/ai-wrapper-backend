import type { Config } from './config/index.ts';
import type { AuthService } from './auth/application/auth-service.ts';
import { createAuthService } from './auth/application/auth-service.ts';
import { BunPasswordHasher } from './auth/infrastructure/bun-password-hasher.ts';
import { DrizzleSessionRepository } from './auth/infrastructure/drizzle-session-repository.ts';
import { DrizzleUserRepository } from './auth/infrastructure/drizzle-user-repository.ts';
import { DrizzleAuditLogRepository } from './audit/infrastructure/drizzle-audit-log-repository.ts';
import { systemClock } from './clock/index.ts';

/**
 * Composition root (AGENTS §3.7). This is the **only** place where infrastructure
 * implementations are bound to the ports the application depends on. Nothing here
 * contains logic — it just assembles the object graph from validated config.
 */
export interface Services {
  readonly auth: AuthService;
}

export function createServices(config: Config): Services {
  const users = new DrizzleUserRepository();
  const sessions = new DrizzleSessionRepository();
  const audit = new DrizzleAuditLogRepository();
  const hasher = new BunPasswordHasher();

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

  return { auth };
}

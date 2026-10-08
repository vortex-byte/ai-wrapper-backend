import type { Clock } from '../../clock/index.ts';
import type { AuditLogRepository } from '../../audit/ports/audit-log-repository.ts';
import type { PasswordPolicy } from '../domain/password-policy.ts';
import type { SessionPolicy } from '../domain/session.ts';
import type { LockoutPolicy } from '../domain/user.ts';
import type { PasswordHasher } from '../ports/password-hasher.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { UserRepository } from '../ports/user-repository.ts';

/** Everything the auth application needs, wired at the composition root (AGENTS §3.7). */
export interface AuthDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditLogRepository;
  readonly clock: Clock;
  readonly lockout: LockoutPolicy;
  readonly sessionPolicy: SessionPolicy;
  readonly passwordPolicy: PasswordPolicy;
}

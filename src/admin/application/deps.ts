import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import type { PasswordHasher } from '@/auth/ports/password-hasher.ts';
import type { SessionRepository } from '@/auth/ports/session-repository.ts';
import type { UserRepository } from '@/auth/ports/user-repository.ts';
import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { DivisionRepository } from '../ports/division-repository.ts';
import type { PasswordPolicy } from '@/auth/domain/password-policy.ts';

export interface AdminDeps {
  readonly users: UserRepository;
  readonly divisions: DivisionRepository;
  readonly sessions: SessionRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditLogRepository;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly passwordPolicy: PasswordPolicy;
}

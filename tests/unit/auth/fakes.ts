import type { AuthDeps } from '../../../src/auth/application/deps.ts';
import type { SessionRecord } from '../../../src/auth/domain/session.ts';
import type { User, UserRole, UserStatus } from '../../../src/auth/domain/user.ts';
import type { PasswordHasher } from '../../../src/auth/ports/password-hasher.ts';
import type {
  NewSession,
  RevokeAllOptions,
  SessionRepository,
  SessionWithUser,
} from '../../../src/auth/ports/session-repository.ts';
import type {
  CreateUserInput,
  LoginFailureState,
  LoginSuccessInput,
  PasswordUpdate,
  UserRepository,
} from '../../../src/auth/ports/user-repository.ts';
import type { AuditEntry, AuditLogRepository } from '../../../src/audit/ports/audit-log-repository.ts';
import type { Clock } from '../../../src/clock/index.ts';

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Deterministic hasher: `hash(p) === "plain$" + p`. Never use outside tests. */
export class FakePasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `plain$${password}`;
  }
  async verify(password: string, hash: string): Promise<boolean> {
    return hash === `plain$${password}`;
  }
}

export function makeUser(overrides: Partial<User> = {}): User {
  const base = new Date('2026-01-01T00:00:00Z');
  return {
    id: overrides.id ?? 'user-1',
    email: overrides.email ?? 'ada@corp.example',
    displayName: overrides.displayName ?? 'Ada L.',
    passwordHash: overrides.passwordHash ?? 'plain$correct horse battery staple',
    passwordUpdatedAt: overrides.passwordUpdatedAt ?? base,
    mustChangePassword: overrides.mustChangePassword ?? false,
    failedLoginAttempts: overrides.failedLoginAttempts ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
    role: overrides.role ?? ('user' as UserRole),
    status: overrides.status ?? ('active' as UserStatus),
    divisionId: overrides.divisionId ?? null,
    createdAt: overrides.createdAt ?? base,
    updatedAt: overrides.updatedAt ?? base,
    lastLoginAt: overrides.lastLoginAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
  };
}

export class InMemoryUserRepository implements UserRepository {
  readonly rows = new Map<string, User>();

  seed(user: User): void {
    this.rows.set(user.id, user);
  }

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const target = email.toLowerCase();
    for (const user of this.rows.values()) {
      if (user.email.toLowerCase() === target) return user;
    }
    return null;
  }

  async create(input: CreateUserInput): Promise<User> {
    const user = makeUser({
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status ?? 'active',
      divisionId: input.divisionId ?? null,
      mustChangePassword: input.mustChangePassword ?? true,
    });
    this.rows.set(user.id, user);
    return user;
  }

  async recordLoginSuccess(input: LoginSuccessInput): Promise<void> {
    const user = this.rows.get(input.id);
    if (!user) return;
    this.rows.set(input.id, {
      ...user,
      lastLoginAt: input.at,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  async recordLoginFailure(id: string, state: LoginFailureState): Promise<void> {
    const user = this.rows.get(id);
    if (!user) return;
    this.rows.set(id, {
      ...user,
      failedLoginAttempts: state.failedLoginAttempts,
      lockedUntil: state.lockedUntil,
    });
  }

  async setPassword(update: PasswordUpdate): Promise<void> {
    const user = this.rows.get(update.id);
    if (!user) return;
    this.rows.set(update.id, {
      ...user,
      passwordHash: update.passwordHash,
      passwordUpdatedAt: update.at,
      mustChangePassword: update.mustChangePassword,
    });
  }
}

interface StoredSession extends SessionRecord {
  readonly ip: string | null;
  readonly userAgentHash: string | null;
}

export class InMemorySessionRepository implements SessionRepository {
  readonly rows = new Map<string, StoredSession>();
  private readonly users: InMemoryUserRepository;

  constructor(users: InMemoryUserRepository) {
    this.users = users;
  }

  async insert(session: NewSession): Promise<void> {
    this.rows.set(session.id, {
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: null,
      rotatedFrom: session.rotatedFrom,
      ip: session.ip,
      userAgentHash: session.userAgentHash,
    });
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findWithUser(id: string): Promise<SessionWithUser | null> {
    const session = this.rows.get(id);
    if (!session) return null;
    const user = this.users.rows.get(session.userId);
    if (!user) return null;
    return { session, user };
  }

  async touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const session = this.rows.get(id);
    if (!session) return;
    this.rows.set(id, { ...session, lastSeenAt, expiresAt });
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    const session = this.rows.get(id);
    if (!session) return;
    this.rows.set(id, { ...session, revokedAt });
  }

  async revokeAllForUser(
    userId: string,
    revokedAt: Date,
    options: RevokeAllOptions = {},
  ): Promise<number> {
    let count = 0;
    for (const [id, session] of this.rows) {
      if (session.userId !== userId || session.revokedAt !== null) continue;
      if (options.exceptId === id) continue;
      this.rows.set(id, { ...session, revokedAt });
      count += 1;
    }
    return count;
  }
}

export class InMemoryAuditRepository implements AuditLogRepository {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

export interface TestHarness {
  readonly deps: AuthDeps;
  readonly users: InMemoryUserRepository;
  readonly sessions: InMemorySessionRepository;
  readonly audit: InMemoryAuditRepository;
  readonly hasher: FakePasswordHasher;
  readonly clock: FixedClock;
}

export function createHarness(options: { now?: Date } = {}): TestHarness {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditRepository();
  const hasher = new FakePasswordHasher();
  const clock = new FixedClock(options.now ?? new Date('2026-05-01T10:00:00Z'));

  const deps: AuthDeps = {
    users,
    sessions,
    hasher,
    audit,
    clock,
    lockout: { maxFailures: 8, lockoutMinutes: 15 },
    sessionPolicy: { idleMinutes: 480, absoluteMinutes: 1440 },
    passwordPolicy: { minLength: 12 },
  };

  return { deps, users, sessions, audit, hasher, clock };
}

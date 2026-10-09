import { and, eq, isNull, ne } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { sessions, users } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { SessionRecord } from '../domain/session.ts';
import type {
  NewSession,
  RevokeAllOptions,
  SessionRepository,
  SessionWithUser,
} from '../ports/session-repository.ts';
import { toUser } from './drizzle-user-repository.ts';

const sessionColumns = {
  id: sessions.id,
  userId: sessions.userId,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
  rotatedFrom: sessions.rotatedFrom,
} as const;

const userColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  passwordHash: users.passwordHash,
  passwordUpdatedAt: users.passwordUpdatedAt,
  mustChangePassword: users.mustChangePassword,
  failedLoginAttempts: users.failedLoginAttempts,
  lockedUntil: users.lockedUntil,
  role: users.role,
  status: users.status,
  divisionId: users.divisionId,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  lastLoginAt: users.lastLoginAt,
  deletedAt: users.deletedAt,
} as const;

export class DrizzleSessionRepository implements SessionRepository {
  async insert(session: NewSession, tx?: TransactionContext): Promise<void> {
    await runDb(tx).insert(sessions).values({
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      rotatedFrom: session.rotatedFrom,
      ip: session.ip,
      userAgentHash: session.userAgentHash,
    });
  }

  async findById(id: string, tx?: TransactionContext): Promise<SessionRecord | null> {
    const rows = await runDb(tx)
      .select(sessionColumns)
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findWithUser(id: string, tx?: TransactionContext): Promise<SessionWithUser | null> {
    const rows = await runDb(tx)
      .select({ session: sessionColumns, user: userColumns })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { session: row.session, user: toUser(row.user) };
  }

  async touch(
    id: string,
    lastSeenAt: Date,
    expiresAt: Date,
    tx?: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(sessions)
      .set({ lastSeenAt, expiresAt })
      .where(eq(sessions.id, id));
  }

  async revoke(id: string, revokedAt: Date, tx?: TransactionContext): Promise<void> {
    await runDb(tx).update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
  }

  async revokeAllForUser(
    userId: string,
    revokedAt: Date,
    options?: RevokeAllOptions,
    tx?: TransactionContext,
  ): Promise<number> {
    const predicate =
      options?.exceptId !== undefined
        ? and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, options.exceptId))
        : and(eq(sessions.userId, userId), isNull(sessions.revokedAt));
    const rows = await runDb(tx)
      .update(sessions)
      .set({ revokedAt })
      .where(predicate)
      .returning({ id: sessions.id });
    return rows.length;
  }
}

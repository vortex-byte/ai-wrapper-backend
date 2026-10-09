import type { TransactionContext } from '@/db/tx.ts';
import type { SessionRecord } from '../domain/session.ts';
import type { User } from '../domain/user.ts';

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly rotatedFrom: string | null;
  readonly ip: string | null;
  readonly userAgentHash: string | null;
}

export interface SessionWithUser {
  readonly session: SessionRecord;
  readonly user: User;
}

export interface RevokeAllOptions {
  /** Keep this session alive (e.g. the caller's own session on password change). */
  readonly exceptId?: string;
}

export interface SessionRepository {
  insert(session: NewSession, tx?: TransactionContext): Promise<void>;
  findById(id: string, tx?: TransactionContext): Promise<SessionRecord | null>;
  /** Session joined with its owner — used to enforce `status='active'` on every request. */
  findWithUser(id: string, tx?: TransactionContext): Promise<SessionWithUser | null>;
  touch(
    id: string,
    lastSeenAt: Date,
    expiresAt: Date,
    tx?: TransactionContext,
  ): Promise<void>;
  revoke(id: string, revokedAt: Date, tx?: TransactionContext): Promise<void>;
  revokeAllForUser(
    userId: string,
    revokedAt: Date,
    options?: RevokeAllOptions,
    tx?: TransactionContext,
  ): Promise<number>;
}

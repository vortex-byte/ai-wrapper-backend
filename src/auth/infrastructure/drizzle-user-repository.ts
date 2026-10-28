import { and, desc, eq, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { runDb } from '@/db/client.ts';
import { users } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import { USER_ROLES, USER_STATUSES, type User, type UserRole, type UserStatus } from '../domain/user.ts';
import type {
  CreateUserInput,
  ListUsersQuery,
  LoginFailureState,
  LoginSuccessInput,
  PasswordUpdate,
  UpdateUserInput,
  UserRepository,
} from '../ports/user-repository.ts';

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

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  passwordUpdatedAt: Date;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  role: string;
  status: string;
  divisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
};

const roleSchema = z.enum(USER_ROLES);
const statusSchema = z.enum(USER_STATUSES);

export function toUser(row: UserRow): User {
  const role: UserRole = roleSchema.parse(row.role);
  const status: UserStatus = statusSchema.parse(row.status);
  return { ...row, role, status };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const createdAt = iso ? new Date(iso) : new Date(Number.NaN);
  if (!iso || !id || Number.isNaN(createdAt.getTime())) {
    throw new AppError('invalid_request', 'Invalid keyset cursor');
  }
  return { createdAt, id };
}

export class DrizzleUserRepository implements UserRepository {
  async findById(id: string, tx?: TransactionContext): Promise<User | null> {
    const rows = await runDb(tx).select(userColumns).from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findByEmail(email: string, tx?: TransactionContext): Promise<User | null> {
    const rows = await runDb(tx)
      .select(userColumns)
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findMany(
    options: ListUsersQuery,
    tx?: TransactionContext,
  ): Promise<{ items: User[]; nextCursor: string | null }> {
    const limit = Math.min(options.limit ?? 50, 100);
    const conditions: SQL[] = [isNull(users.deletedAt)];

    if (options.status) {
      conditions.push(eq(users.status, options.status));
    }
    if (options.divisionId) {
      conditions.push(eq(users.divisionId, options.divisionId));
    }
    if (options.query) {
      const pattern = `%${options.query.trim()}%`;
      const search = or(ilike(users.email, pattern), ilike(users.displayName, pattern));
      if (search) conditions.push(search);
    }

    if (options.cursor) {
      const parsed = decodeCursor(options.cursor);
      const keyset = or(
        lt(users.createdAt, parsed.createdAt),
        and(eq(users.createdAt, parsed.createdAt), lt(users.id, parsed.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await runDb(tx)
      .select(userColumns)
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasNext = rows.length > limit;
    const itemRows = hasNext ? rows.slice(0, limit) : rows;
    const items = itemRows.map(toUser);

    let nextCursor: string | null = null;
    if (hasNext && itemRows.length > 0) {
      const last = itemRows[itemRows.length - 1];
      if (last !== undefined) {
        nextCursor = encodeCursor(last.createdAt, last.id);
      }
    }

    return { items, nextCursor };
  }

  async create(input: CreateUserInput, tx?: TransactionContext): Promise<User> {
    const rows = await runDb(tx)
      .insert(users)
      .values({
        id: input.id,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: input.role,
        status: input.status ?? 'active',
        divisionId: input.divisionId ?? null,
        mustChangePassword: input.mustChangePassword ?? true,
      })
      .returning(userColumns);
    const row = rows[0];
    if (!row) throw new Error('insert into users returned no row');
    return toUser(row);
  }

  async update(input: UpdateUserInput, tx?: TransactionContext): Promise<User> {
    const updates: Record<string, unknown> = {
      updatedAt: input.at ?? new Date(),
    };
    if (input.email !== undefined) updates.email = input.email;
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.role !== undefined) updates.role = input.role;
    if (input.status !== undefined) updates.status = input.status;
    if (input.divisionId !== undefined) updates.divisionId = input.divisionId;

    const rows = await runDb(tx)
      .update(users)
      .set(updates)
      .where(eq(users.id, input.id))
      .returning(userColumns);

    const row = rows[0];
    if (!row) throw new Error(`user not found: ${input.id}`);
    return toUser(row);
  }

  async countActiveSuperAdmins(tx?: TransactionContext): Promise<number> {
    const rows = await runDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.role, 'super_admin'), eq(users.status, 'active'), isNull(users.deletedAt)));
    return rows[0]?.count ?? 0;
  }

  async lockActiveSuperAdmins(tx: TransactionContext): Promise<number> {
    const rows = await runDb(tx)
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'super_admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
      .for('update');
    return rows.length;
  }

  async recordLoginSuccess(input: LoginSuccessInput, tx?: TransactionContext): Promise<void> {
    await runDb(tx)
      .update(users)
      .set({
        lastLoginAt: input.at,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: input.at,
      })
      .where(eq(users.id, input.id));
  }

  async recordLoginFailure(
    id: string,
    state: LoginFailureState,
    tx?: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(users)
      .set({
        failedLoginAttempts: state.failedLoginAttempts,
        lockedUntil: state.lockedUntil,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
  }

  async setPassword(update: PasswordUpdate, tx?: TransactionContext): Promise<void> {
    await runDb(tx)
      .update(users)
      .set({
        passwordHash: update.passwordHash,
        passwordUpdatedAt: update.at,
        mustChangePassword: update.mustChangePassword,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: update.at,
      })
      .where(eq(users.id, update.id));
  }

  async delete(id: string, at: Date, tx?: TransactionContext): Promise<void> {
    await runDb(tx)
      .update(users)
      .set({
        status: 'disabled',
        deletedAt: at,
        updatedAt: at,
      })
      .where(eq(users.id, id));
  }
}

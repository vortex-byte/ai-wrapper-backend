import { eq } from 'drizzle-orm';
import { runDb } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import type { TransactionContext } from '../../db/tx.ts';
import type { User, UserRole, UserStatus } from '../domain/user.ts';
import type {
  CreateUserInput,
  LoginFailureState,
  LoginSuccessInput,
  PasswordUpdate,
  UserRepository,
} from '../ports/user-repository.ts';

/** Explicit column projection (AGENTS §5: never `SELECT *`). */
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

export type UserRow = {
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

export function toUser(row: UserRow): User {
  return { ...row, role: row.role as UserRole, status: row.status as UserStatus };
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
      .where(eq(users.email, email))
      .limit(1);
    return rows[0] ? toUser(rows[0]) : null;
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
        updatedAt: update.at,
      })
      .where(eq(users.id, update.id));
  }
}

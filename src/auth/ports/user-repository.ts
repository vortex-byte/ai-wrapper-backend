import type { TransactionContext } from '@/db/tx.ts';
import type { User, UserRole, UserStatus } from '../domain/user.ts';

export interface CreateUserInput {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status?: UserStatus | undefined;
  readonly divisionId?: string | null | undefined;
  readonly mustChangePassword?: boolean | undefined;
}

export interface LoginSuccessInput {
  readonly id: string;
  readonly at: Date;
  readonly ip: string | null;
  readonly userAgentHash: string | null;
}

export interface LoginFailureState {
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
}

export interface PasswordUpdate {
  readonly id: string;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly at: Date;
}

export interface ListUsersQuery {
  readonly query?: string | undefined;
  readonly divisionId?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface UpdateUserInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly role?: UserRole | undefined;
  readonly status?: UserStatus | undefined;
  readonly divisionId?: string | null | undefined;
  readonly at?: Date | undefined;
}

/** Persistence port for users. Methods return domain entities. */
export interface UserRepository {
  findById(id: string, tx?: TransactionContext): Promise<User | null>;
  findByEmail(email: string, tx?: TransactionContext): Promise<User | null>;
  findMany(
    options: ListUsersQuery,
    tx?: TransactionContext,
  ): Promise<{ items: User[]; nextCursor: string | null }>;
  create(input: CreateUserInput, tx?: TransactionContext): Promise<User>;
  update(input: UpdateUserInput, tx?: TransactionContext): Promise<User>;
  countActiveSuperAdmins(tx?: TransactionContext): Promise<number>;
  lockActiveSuperAdmins(tx: TransactionContext): Promise<number>;
  recordLoginSuccess(input: LoginSuccessInput, tx?: TransactionContext): Promise<void>;
  recordLoginFailure(
    id: string,
    state: LoginFailureState,
    tx?: TransactionContext,
  ): Promise<void>;
  setPassword(update: PasswordUpdate, tx?: TransactionContext): Promise<void>;
}

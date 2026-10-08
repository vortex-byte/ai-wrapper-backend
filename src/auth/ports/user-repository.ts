import type { TransactionContext } from '../../db/tx.ts';
import type { User, UserRole, UserStatus } from '../domain/user.ts';

export interface CreateUserInput {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status?: UserStatus;
  readonly divisionId?: string | null;
  readonly mustChangePassword?: boolean;
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

/**
 * Persistence port for users. Every method returns plain domain objects; the domain
 * never sees a table (AGENTS §3.3). `tx` carries the Unit of Work handle when the
 * caller needs it; the repository never opens a transaction itself.
 */
export interface UserRepository {
  findById(id: string, tx?: TransactionContext): Promise<User | null>;
  findByEmail(email: string, tx?: TransactionContext): Promise<User | null>;
  create(input: CreateUserInput, tx?: TransactionContext): Promise<User>;
  recordLoginSuccess(input: LoginSuccessInput, tx?: TransactionContext): Promise<void>;
  recordLoginFailure(
    id: string,
    state: LoginFailureState,
    tx?: TransactionContext,
  ): Promise<void>;
  setPassword(update: PasswordUpdate, tx?: TransactionContext): Promise<void>;
}

import { AUDIT_ACTIONS } from '@/audit/actions.ts';
import { passwordProblemMessage, validatePassword } from '@/auth/domain/password-policy.ts';
import type { User, UserRole, UserStatus } from '@/auth/domain/user.ts';
import type { ListUsersQuery } from '@/auth/ports/user-repository.ts';
import { withTransaction } from '@/db/index.ts';
import { AppError, isUniqueViolation } from '@/errors.ts';
import type { RequestMeta } from '@/request-context.ts';
import { canUpdateUserRoleOrStatus } from '../domain/last-admin.ts';
import { generateTemporaryPassword } from '@/crypto.ts';
import type { Division } from '../ports/division-repository.ts';
import type { AdminDeps } from './deps.ts';

/** User projection for the admin surface; omits password hashes and failure counters. */
export type PublicUser = Omit<User, 'passwordHash' | 'failedLoginAttempts' | 'lockedUntil'>;

function toPublicUser(user: User): PublicUser {
  const {
    passwordHash: _passwordHash,
    failedLoginAttempts: _failedLoginAttempts,
    lockedUntil: _lockedUntil,
    ...rest
  } = user;
  return rest;
}

export interface CallerContext {
  readonly actorUserId: string;
  readonly role: UserRole;
  readonly divisionId: string | null;
  readonly meta: RequestMeta;
}

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly divisionId?: string | null | undefined;
  readonly initialPassword?: string | undefined;
  readonly generatePassword?: boolean | undefined;
  readonly caller: CallerContext;
}

export interface CreateUserResult {
  readonly user: PublicUser;
  readonly temporaryPassword?: string | undefined;
}

export interface UpdateUserInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly role?: UserRole | undefined;
  readonly status?: UserStatus | undefined;
  readonly divisionId?: string | null | undefined;
  readonly caller: CallerContext;
}

export interface ResetPasswordInput {
  readonly id: string;
  readonly newPassword?: string | undefined;
  readonly generatePassword?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly caller: CallerContext;
}

export interface ResetPasswordResult {
  readonly temporaryPassword?: string | undefined;
}

export interface CreateDivisionInput {
  readonly name: string;
  readonly externalRef?: string | null | undefined;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface UpdateDivisionInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly externalRef?: string | null | undefined;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface AdminService {
  listUsers(
    query: ListUsersQuery,
    caller: CallerContext,
  ): Promise<{ items: PublicUser[]; nextCursor: string | null }>;
  getUser(id: string, caller: CallerContext): Promise<PublicUser>;
  createUser(input: CreateUserInput): Promise<CreateUserResult>;
  updateUser(input: UpdateUserInput): Promise<PublicUser>;
  resetUserPassword(input: ResetPasswordInput): Promise<ResetPasswordResult>;

  listDivisions(): Promise<Division[]>;
  createDivision(input: CreateDivisionInput): Promise<Division>;
  updateDivision(input: UpdateDivisionInput): Promise<Division>;
}

export function createAdminService(deps: AdminDeps): AdminService {
  return {
    async listUsers(query, caller) {
      if (caller.role === 'admin' && !caller.divisionId) {
        throw new AppError('forbidden', 'Division administrator must belong to a division.');
      }

      const effectiveQuery: ListUsersQuery =
        caller.role === 'admin'
          ? {
              ...query,
              divisionId: caller.divisionId ?? undefined,
            }
          : query;

      const result = await deps.users.findMany(effectiveQuery);
      return { items: result.items.map(toPublicUser), nextCursor: result.nextCursor };
    },

    async getUser(id, caller) {
      const user = await deps.users.findById(id);
      if (user === null || user.deletedAt !== null) {
        throw new AppError('not_found', 'User not found.');
      }

      if (caller.role === 'admin') {
        if (
          !caller.divisionId ||
          user.divisionId !== caller.divisionId ||
          (user.role !== 'user' && user.id !== caller.actorUserId)
        ) {
          throw new AppError('not_found', 'User not found.');
        }
      }

      return toPublicUser(user);
    },

    async createUser(input) {
      const { caller } = input;

      if (caller.role === 'admin') {
        if (input.role !== 'user') {
          throw new AppError(
            'forbidden',
            'Division administrators can only provision users with the user role.',
          );
        }
        if (!caller.divisionId) {
          throw new AppError('forbidden', 'Division administrator must belong to a division.');
        }
      } else if (caller.role === 'super_admin') {
        if (input.role === 'admin' && !input.divisionId) {
          throw new AppError('invalid_request', 'Division administrator must be assigned to a division.');
        }
      }

      const assignedDivisionId =
        caller.role === 'admin' ? caller.divisionId : (input.divisionId ?? null);

      const existing = await deps.users.findByEmail(input.email);
      if (existing !== null && existing.deletedAt === null) {
        throw new AppError('conflict', 'A user with this email already exists.');
      }

      let passwordToUse = input.initialPassword;
      let temporaryPassword: string | undefined;

      if (input.generatePassword || !passwordToUse) {
        temporaryPassword = generateTemporaryPassword();
        passwordToUse = temporaryPassword;
      }

      const problem = validatePassword(passwordToUse, deps.passwordPolicy);
      if (problem !== null) {
        throw new AppError('invalid_request', passwordProblemMessage(problem, deps.passwordPolicy));
      }

      if (assignedDivisionId) {
        const division = await deps.divisions.findById(assignedDivisionId);
        if (division === null) {
          throw new AppError('invalid_request', 'Division not found.');
        }
      }

      const newId = deps.idGen.uuidv7();
      const passwordHash = await deps.hasher.hash(passwordToUse);

      return withTransaction(async (tx) => {
        let user: User;
        try {
          user = await deps.users.create(
            {
              id: newId,
              email: input.email,
              displayName: input.displayName,
              passwordHash,
              role: input.role,
              status: 'active',
              divisionId: assignedDivisionId,
              mustChangePassword: true,
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError('conflict', 'A user with this email already exists.', {
              cause: error,
            });
          }
          throw error;
        }

        await deps.audit.append(
          {
            actorUserId: caller.actorUserId,
            action: AUDIT_ACTIONS.userCreate,
            targetType: 'user',
            targetId: user.id,
            after: {
              email: user.email,
              displayName: user.displayName,
              role: user.role,
              status: user.status,
              divisionId: user.divisionId,
            },
            requestId: caller.meta.requestId,
            ip: caller.meta.ip,
            userAgentHash: caller.meta.userAgentHash,
          },
          tx,
        );

        return { user: toPublicUser(user), temporaryPassword };
      });
    },

    async updateUser(input) {
      const { caller } = input;
      const now = deps.clock.now();

      return withTransaction(async (tx) => {
        const target = await deps.users.findById(input.id, tx);
        if (target === null || target.deletedAt !== null) {
          throw new AppError('not_found', 'User not found.');
        }

        if (caller.role === 'admin') {
          if (!caller.divisionId || target.divisionId !== caller.divisionId) {
            throw new AppError('not_found', 'User not found.');
          }
          if (target.role !== 'user' && target.id !== caller.actorUserId) {
            throw new AppError('not_found', 'User not found.');
          }
          if (input.role !== undefined) {
            throw new AppError('forbidden', 'Division administrators cannot change user roles.');
          }
          if (input.divisionId !== undefined) {
            throw new AppError(
              'forbidden',
              'Division administrators cannot reassign user divisions.',
            );
          }
          if (target.id === caller.actorUserId && input.status === 'disabled') {
            throw new AppError('forbidden', 'Cannot disable your own administrator account.');
          }
        }

        const effectiveDivisionId =
          input.divisionId !== undefined ? input.divisionId : target.divisionId;
        const effectiveRole = input.role !== undefined ? input.role : target.role;

        if (effectiveRole === 'admin' && !effectiveDivisionId) {
          throw new AppError(
            'invalid_request',
            'Division administrator must be assigned to a division.',
          );
        }

        if (input.divisionId) {
          const division = await deps.divisions.findById(input.divisionId, tx);
          if (division === null) {
            throw new AppError('invalid_request', 'Division not found.');
          }
        }

        const isDemotingOrDisablingSuperAdmin =
          target.role === 'super_admin' &&
          target.status === 'active' &&
          ((input.role !== undefined && input.role !== 'super_admin') ||
            (input.status !== undefined && input.status !== 'active'));

        if (isDemotingOrDisablingSuperAdmin) {
          const activeSuperAdminCount = await deps.users.lockActiveSuperAdmins(tx);
          const allowed = canUpdateUserRoleOrStatus({
            targetUser: target,
            newRole: input.role,
            newStatus: input.status,
            activeSuperAdminCount,
          });

          if (!allowed) {
            throw new AppError('conflict', 'Cannot disable or demote the last active super admin.');
          }
        }

        if (input.status === 'disabled' && target.status !== 'disabled') {
          await deps.sessions.revokeAllForUser(target.id, now, undefined, tx);
        }

        const updated = await deps.users.update(
          {
            id: target.id,
            displayName: input.displayName,
            role: input.role,
            status: input.status,
            divisionId: input.divisionId,
            at: now,
          },
          tx,
        );

        await deps.audit.append(
          {
            actorUserId: caller.actorUserId,
            action: AUDIT_ACTIONS.userUpdate,
            targetType: 'user',
            targetId: target.id,
            before: {
              displayName: target.displayName,
              role: target.role,
              status: target.status,
              divisionId: target.divisionId,
            },
            after: {
              displayName: updated.displayName,
              role: updated.role,
              status: updated.status,
              divisionId: updated.divisionId,
            },
            requestId: caller.meta.requestId,
            ip: caller.meta.ip,
            userAgentHash: caller.meta.userAgentHash,
          },
          tx,
        );

        return toPublicUser(updated);
      });
    },

    async resetUserPassword(input) {
      const { caller } = input;
      const now = deps.clock.now();

      let passwordToUse = input.newPassword;
      let temporaryPassword: string | undefined;

      if (input.generatePassword || !passwordToUse) {
        temporaryPassword = generateTemporaryPassword();
        passwordToUse = temporaryPassword;
      }

      const problem = validatePassword(passwordToUse, deps.passwordPolicy);
      if (problem !== null) {
        throw new AppError('invalid_request', passwordProblemMessage(problem, deps.passwordPolicy));
      }

      const passwordHash = await deps.hasher.hash(passwordToUse);

      return withTransaction(async (tx) => {
        const target = await deps.users.findById(input.id, tx);
        if (target === null || target.deletedAt !== null) {
          throw new AppError('not_found', 'User not found.');
        }

        if (caller.role === 'admin') {
          if (
            !caller.divisionId ||
            target.divisionId !== caller.divisionId ||
            target.role !== 'user'
          ) {
            throw new AppError('not_found', 'User not found.');
          }
        }

        await deps.users.setPassword(
          {
            id: target.id,
            passwordHash,
            mustChangePassword: true,
            at: now,
          },
          tx,
        );

        await deps.sessions.revokeAllForUser(target.id, now, undefined, tx);

        await deps.audit.append(
          {
            actorUserId: caller.actorUserId,
            action: AUDIT_ACTIONS.passwordReset,
            targetType: 'user',
            targetId: target.id,
            after: { reason: input.reason ?? null },
            requestId: caller.meta.requestId,
            ip: caller.meta.ip,
            userAgentHash: caller.meta.userAgentHash,
          },
          tx,
        );

        return { temporaryPassword };
      });
    },

    async listDivisions() {
      return deps.divisions.findMany();
    },

    async createDivision(input) {
      const existing = await deps.divisions.findByName(input.name);
      if (existing !== null) {
        throw new AppError('conflict', 'A division with this name already exists.');
      }

      const id = deps.idGen.uuidv7();

      return withTransaction(async (tx) => {
        let division: Division;
        try {
          division = await deps.divisions.create(
            {
              id,
              name: input.name,
              externalRef: input.externalRef ?? null,
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError('conflict', 'A division with this name already exists.', {
              cause: error,
            });
          }
          throw error;
        }

        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.divisionCreate,
            targetType: 'division',
            targetId: division.id,
            after: { name: division.name, externalRef: division.externalRef },
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );

        return division;
      });
    },

    async updateDivision(input) {
      return withTransaction(async (tx) => {
        const target = await deps.divisions.findById(input.id, tx);
        if (target === null) {
          throw new AppError('not_found', 'Division not found.');
        }

        if (input.name && input.name !== target.name) {
          const existing = await deps.divisions.findByName(input.name, tx);
          if (existing !== null) {
            throw new AppError('conflict', 'A division with this name already exists.');
          }
        }

        const updated = await deps.divisions.update(
          {
            id: input.id,
            name: input.name,
            externalRef: input.externalRef,
          },
          tx,
        );

        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.divisionUpdate,
            targetType: 'division',
            targetId: updated.id,
            before: { name: target.name, externalRef: target.externalRef },
            after: { name: updated.name, externalRef: updated.externalRef },
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );

        return updated;
      });
    },
  };
}

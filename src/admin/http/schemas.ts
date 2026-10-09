import { z } from 'zod';
import { USER_ROLES, USER_STATUSES } from '@/auth/domain/user.ts';

/**
 * A keyset cursor is `base64url("<iso-created-at>|<uuid>")` (see the user repository's
 * codec). Validating its shape here turns a corrupt cursor into `400 invalid_request`
 * instead of silently returning the first page.
 */
const CursorSchema = z
  .string()
  .refine((value) => {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const [iso, id] = decoded.split('|');
      if (!iso || !id) return false;
      if (Number.isNaN(new Date(iso).getTime())) return false;
      return z.uuid().safeParse(id).success;
    } catch {
      return false;
    }
  }, 'The cursor is invalid or expired.')
  .optional();

export const ListUsersQuerySchema = z.object({
  query: z.string().trim().optional(),
  divisionId: z.string().uuid().optional(),
  status: z.enum(USER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema,
});

export const CreateUserBodySchema = z
  .object({
    email: z.email().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(256),
    role: z.enum(USER_ROLES),
    divisionId: z.uuid().nullable().optional(),
    initialPassword: z.string().min(1).max(1024).optional(),
    generatePassword: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.generatePassword && !data.initialPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['initialPassword'],
        message: 'Either initialPassword or generatePassword: true must be provided.',
      });
    }
  });

export const UpdateUserBodySchema = z.object({
  displayName: z.string().trim().min(1).max(256).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  divisionId: z.string().uuid().nullable().optional(),
});

export const ResetUserPasswordBodySchema = z
  .object({
    newPassword: z.string().min(1).max(1024).optional(),
    generatePassword: z.boolean().optional(),
    reason: z.string().trim().max(1024).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.generatePassword && !data.newPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: 'Either newPassword or generatePassword: true must be provided.',
      });
    }
  });

export const CreateDivisionBodySchema = z.object({
  name: z.string().trim().min(1).max(256),
  externalRef: z.string().trim().max(256).nullable().optional(),
});

export const UpdateDivisionBodySchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  externalRef: z.string().trim().max(256).nullable().optional(),
});

import { z } from 'zod';

/** Request schemas for the auth routes (API_CONTRACTS §2). Validated at the boundary. */

export const LoginBodySchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
  password: z.string().min(1).max(1024),
});

export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

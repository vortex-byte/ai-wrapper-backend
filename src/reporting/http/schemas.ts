import { z } from 'zod';

const ISO_DATE = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Must be an ISO-8601 date.');

export const UsageGroupBySchema = z.enum(['user', 'model', 'provider', 'day', 'month', 'division']);

export const UsageQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  groupBy: UsageGroupBySchema.default('day'),
});

export const UsageExportQuerySchema = UsageQuerySchema;

export const ListQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export const ErrorExplorerQuerySchema = ListQuerySchema.extend({
  category: z.string().trim().min(1).max(64).optional(),
  providerId: z.uuid().optional(),
  modelId: z.uuid().optional(),
});

export const AuditSearchQuerySchema = ListQuerySchema.extend({
  actorUserId: z.uuid().optional(),
  action: z.string().trim().min(1).max(128).optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
});

export type UsageQuery = z.infer<typeof UsageQuerySchema>;
export type ErrorExplorerQuery = z.infer<typeof ErrorExplorerQuerySchema>;
export type AuditSearchQuery = z.infer<typeof AuditSearchQuerySchema>;

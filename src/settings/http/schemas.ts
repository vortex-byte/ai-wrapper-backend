import { z } from 'zod';
import {
  AttachmentsConfigSchema,
  QuotaTimezoneSchema,
  SecurityConfigSchema,
  SystemPromptSchema,
} from '../domain/settings.ts';

export const UpdatePlatformSettingsBodySchema = z
  .object({
    systemPrompt: SystemPromptSchema.optional(),
    quotaTimezone: QuotaTimezoneSchema.optional(),
    attachments: AttachmentsConfigSchema.optional(),
    security: SecurityConfigSchema.optional(),
  })
  .refine(
    (data) =>
      data.systemPrompt !== undefined ||
      data.quotaTimezone !== undefined ||
      data.attachments !== undefined ||
      data.security !== undefined,
    { message: 'At least one setting must be provided for update.' },
  );

export type UpdatePlatformSettingsBody = z.infer<typeof UpdatePlatformSettingsBodySchema>;

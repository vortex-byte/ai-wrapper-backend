import { z } from 'zod';

export interface SettingUpdater {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export interface SystemSetting<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly version: number;
  readonly updatedBy: SettingUpdater | null;
  readonly updatedAt: Date;
}

export const KNOWN_SETTINGS = {
  quotaTimezone: 'quota.timezone',
  systemPrompt: 'system.prompt',
  attachments: 'attachments.config',
  security: 'security.config',
} as const;

export const QuotaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA time zone');

export const SystemPromptSchema = z.string().trim().max(10_000);

export const AttachmentsConfigSchema = z.object({
  maxBytesPerFile: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024),
  maxFilesPerRequest: z.number().int().min(1).max(20),
  retentionHours: z.number().int().min(1).max(720),
});

export const SecurityConfigSchema = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(10_080),
  loginMaxFailures: z.number().int().min(3).max(50),
  loginLockoutMinutes: z.number().int().min(1).max(1440),
});

export type AttachmentsConfig = z.infer<typeof AttachmentsConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const DEFAULT_SETTINGS = {
  quotaTimezone: 'Asia/Jakarta',
  systemPrompt: '',
  attachments: {
    maxBytesPerFile: 30 * 1024 * 1024,
    maxFilesPerRequest: 5,
    retentionHours: 24,
  },
  security: {
    sessionIdleMinutes: 480,
    loginMaxFailures: 8,
    loginLockoutMinutes: 15,
  },
} as const;

export function parseSettingValue<T>(key: string, value: unknown): T {
  if (key === KNOWN_SETTINGS.quotaTimezone) {
    return QuotaTimezoneSchema.parse(value) as T;
  }
  if (key === KNOWN_SETTINGS.systemPrompt) {
    return SystemPromptSchema.parse(value) as T;
  }
  if (key === KNOWN_SETTINGS.attachments) {
    return AttachmentsConfigSchema.parse(value) as T;
  }
  if (key === KNOWN_SETTINGS.security) {
    return SecurityConfigSchema.parse(value) as T;
  }
  return value as T;
}

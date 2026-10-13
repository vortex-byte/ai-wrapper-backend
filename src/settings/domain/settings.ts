import { z } from 'zod';

export interface SystemSetting<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export const KNOWN_SETTINGS = {
  quotaTimezone: 'quota.timezone',
  systemPrompt: 'system.prompt',
} as const;

export const QuotaTimezoneSchema = z.string().trim().min(1);
export const SystemPromptSchema = z.string().trim().max(10_000);

export function parseSettingValue<T>(key: string, value: unknown): T {
  if (key === KNOWN_SETTINGS.quotaTimezone) {
    return QuotaTimezoneSchema.parse(value) as T;
  }
  if (key === KNOWN_SETTINGS.systemPrompt) {
    return SystemPromptSchema.parse(value) as T;
  }
  return value as T;
}

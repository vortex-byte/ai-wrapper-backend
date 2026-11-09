import { describe, expect, it } from 'vitest';

import { readAttachmentRetention, type SettingsLookup } from '@/attachments/application/retention.ts';
import {
  AttachmentsConfigSchema,
  DEFAULT_SETTINGS,
  parseSettingValue,
  KNOWN_SETTINGS,
} from '@/settings/domain/settings.ts';

describe('attachments config', () => {
  it('defaults providerFileRetentionDays for values stored before the field existed', () => {
    const parsed = AttachmentsConfigSchema.parse({
      maxBytesPerFile: 10 * 1024 * 1024,
      maxFilesPerRequest: 3,
      retentionHours: 24,
    });

    expect(parsed.providerFileRetentionDays).toBe(30);
  });

  it('rejects a retention window outside 1–365 days', () => {
    expect(() =>
      parseSettingValue(KNOWN_SETTINGS.attachments, {
        maxBytesPerFile: 10 * 1024 * 1024,
        maxFilesPerRequest: 3,
        retentionHours: 24,
        providerFileRetentionDays: 0,
      }),
    ).toThrow();

    expect(() =>
      parseSettingValue(KNOWN_SETTINGS.attachments, {
        maxBytesPerFile: 10 * 1024 * 1024,
        maxFilesPerRequest: 3,
        retentionHours: 24,
        providerFileRetentionDays: 366,
      }),
    ).toThrow();
  });
});

describe('readAttachmentRetention', () => {
  it('reads the super-admin configuration', async () => {
    const retention = await readAttachmentRetention({
      get: async () => ({
        value: {
          maxBytesPerFile: 10 * 1024 * 1024,
          maxFilesPerRequest: 3,
          retentionHours: 48,
          providerFileRetentionDays: 7,
        },
      }),
    } as unknown as SettingsLookup);
    expect(retention).toEqual({ retentionHours: 48, providerFileRetentionDays: 7 });
  });

  it('falls back to defaults when the setting is absent', async () => {
    const retention = await readAttachmentRetention({ get: async () => null });

    expect(retention).toEqual({
      retentionHours: DEFAULT_SETTINGS.attachments.retentionHours,
      providerFileRetentionDays: DEFAULT_SETTINGS.attachments.providerFileRetentionDays,
    });
  });

  it('falls back to defaults when the settings store throws', async () => {
    const retention = await readAttachmentRetention({
      get: async () => {
        throw new Error('db down');
      },
    });

    expect(retention.providerFileRetentionDays).toBe(
      DEFAULT_SETTINGS.attachments.providerFileRetentionDays,
    );
  });
});

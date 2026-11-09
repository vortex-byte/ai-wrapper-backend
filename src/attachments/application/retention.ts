import { DEFAULT_SETTINGS, KNOWN_SETTINGS, type AttachmentsConfig } from '@/settings/domain/settings.ts';

/** The slice of `SettingsService` a retention reader needs. */
export interface SettingsLookup {
  get<T = unknown>(key: string): Promise<{ readonly value: T } | null>;
}

export interface AttachmentRetention {
  /** Local blob lifetime, in hours. */
  readonly retentionHours: number;
  /** Provider-hosted copy lifetime, in days. */
  readonly providerFileRetentionDays: number;
}

/** Reads the super-admin attachment config, falling back to defaults when unset. */
export async function readAttachmentRetention(
  settings: SettingsLookup | undefined,
): Promise<AttachmentRetention> {
  const fallback: AttachmentRetention = {
    retentionHours: DEFAULT_SETTINGS.attachments.retentionHours,
    providerFileRetentionDays: DEFAULT_SETTINGS.attachments.providerFileRetentionDays,
  };
  if (settings === undefined) return fallback;

  try {
    const setting = await settings.get<AttachmentsConfig>(KNOWN_SETTINGS.attachments);
    if (setting === null) return fallback;
    return {
      retentionHours: setting.value.retentionHours ?? fallback.retentionHours,
      providerFileRetentionDays:
        setting.value.providerFileRetentionDays ?? fallback.providerFileRetentionDays,
    };
  } catch {
    return fallback;
  }
}

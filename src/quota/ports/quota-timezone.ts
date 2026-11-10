/** Quota timezone (`system_settings.quota.timezone`), resolved per call so admin edits apply without a restart. */
export type QuotaTimezoneProvider = () => Promise<string>;

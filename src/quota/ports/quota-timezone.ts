/**
 * Provides the timezone that quota periods are anchored to (system_settings `quota.timezone`).
 * Resolved per call so an admin edit applies to newly created periods without a restart.
 */
export type QuotaTimezoneProvider = () => Promise<string>;

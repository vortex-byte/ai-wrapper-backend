import type { Clock } from '@/clock/index.ts';
import type { SystemSetting } from '../domain/settings.ts';

/** The slice of `SettingsService` a runtime consumer needs. */
export interface SettingsLookup {
  get<T = unknown>(key: string): Promise<SystemSetting<T> | null>;
}

interface CachedEntry {
  readonly expiresAtMs: number;
  readonly setting: SystemSetting | null;
}

export interface CachedSettingsReaderDeps {
  readonly source: SettingsLookup;
  readonly clock: Clock;
  /** Short TTL so admin edits propagate without hammering the settings row on hot paths. */
  readonly ttlMs: number;
}

/**
 * TTL-cached wrapper over a {@link SettingsLookup}. Use this when the value is read on a
 * per-request path (e.g. session resolution) that must not issue a DB query every time.
 * Not for write paths — `SettingsService.set` must go through the uncached service so the
 * audit row and version bump stay in one transaction.
 */
export function createCachedSettingsReader(deps: CachedSettingsReaderDeps): SettingsLookup {
  const cache = new Map<string, CachedEntry>();
  return {
    async get<T = unknown>(key: string): Promise<SystemSetting<T> | null> {
      const nowMs = deps.clock.now().getTime();
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAtMs > nowMs) {
        return hit.setting as SystemSetting<T> | null;
      }
      const setting = await deps.source.get<T>(key);
      cache.set(key, { expiresAtMs: nowMs + deps.ttlMs, setting });
      return setting;
    },
  };
}

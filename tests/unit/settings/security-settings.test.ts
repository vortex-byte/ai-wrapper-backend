import { describe, expect, it } from 'vitest';
import type { Clock } from '@/clock/index.ts';
import type { SystemSetting } from '@/settings/domain/settings.ts';
import { createCachedSettingsReader, type SettingsLookup } from '@/settings/application/cached-settings-reader.ts';
import { buildSessionPolicies } from '@/auth/application/security-settings.ts';

class FixedClock implements Clock {
  constructor(private current: Date = new Date('2026-05-01T10:00:00Z')) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function lookupWith(rows: Record<string, unknown>): { lookup: SettingsLookup; hits: { count: number } } {
  const hits = { count: 0 };
  const lookup: SettingsLookup = {
    get<T = unknown>(key: string): Promise<SystemSetting<T> | null> {
      hits.count++;
      const value = rows[key];
      return Promise.resolve(
        (value === undefined ? null : { key, value, version: 1, updatedBy: null, updatedAt: new Date() }) as SystemSetting<T> | null,
      );
    },
  };
  return { lookup, hits };
}

describe('createCachedSettingsReader', () => {
  it('serves repeat reads from cache within the TTL', async () => {
    const clock = new FixedClock();
    const { lookup, hits } = lookupWith({ 'security.config': { loginMaxFailures: 5 } });
    const reader = createCachedSettingsReader({ source: lookup, clock, ttlMs: 30_000 });

    const first = await reader.get('security.config');
    const second = await reader.get('security.config');
    expect(hits.count).toBe(1);
    expect((second?.value as { loginMaxFailures: number }).loginMaxFailures).toBe(5);
    expect(first).toBe(second);
  });

  it('re-reads after the TTL expires', async () => {
    const clock = new FixedClock();
    const { lookup, hits } = lookupWith({ 'quota.timezone': 'Asia/Jakarta' });
    const reader = createCachedSettingsReader({ source: lookup, clock, ttlMs: 30_000 });

    await reader.get('quota.timezone');
    clock.advance(30_001);
    await reader.get('quota.timezone');
    expect(hits.count).toBe(2);
  });

  it('caches negative (missing) results without short-circuiting the TTL', async () => {
    const clock = new FixedClock();
    const { lookup, hits } = lookupWith({});
    const reader = createCachedSettingsReader({ source: lookup, clock, ttlMs: 30_000 });

    expect(await reader.get('security.config')).toBeNull();
    expect(await reader.get('security.config')).toBeNull();
    expect(hits.count).toBe(1);
  });
});

describe('buildSessionPolicies', () => {
  it('falls back per-field to DEFAULT_SETTINGS.security', () => {
    const policies = buildSessionPolicies({ sessionIdleMinutes: 120 }, 1440);
    expect(policies.sessionPolicy.idleMinutes).toBe(120);
    expect(policies.sessionPolicy.absoluteMinutes).toBe(1440);
    expect(policies.lockout.maxFailures).toBe(8);
    expect(policies.lockout.lockoutMinutes).toBe(15);
  });

  it('uses every stored field when present', () => {
    const policies = buildSessionPolicies(
      { sessionIdleMinutes: 60, loginMaxFailures: 10, loginLockoutMinutes: 30 },
      2880,
    );
    expect(policies.sessionPolicy.idleMinutes).toBe(60);
    expect(policies.lockout.maxFailures).toBe(10);
    expect(policies.lockout.lockoutMinutes).toBe(30);
  });

  it('uses full defaults when the setting is missing', () => {
    const policies = buildSessionPolicies(undefined, 1440);
    expect(policies.sessionPolicy.idleMinutes).toBe(480);
    expect(policies.lockout.maxFailures).toBe(8);
    expect(policies.lockout.lockoutMinutes).toBe(15);
  });
});

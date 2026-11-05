import { describe, expect, it } from 'vitest';
import { RealQuota } from '@/quota/infrastructure/real-quota.ts';
import type { QuotaAccountRepository } from '@/quota/ports/quota-account-repository.ts';
import type { QuotaPolicyRepository } from '@/quota/ports/quota-policy-repository.ts';
import type { UsageRepository } from '@/quota/ports/usage-repository.ts';
import type { Clock, IdGenerator } from '@/clock/clock.ts';
import { PLATFORM_DEFAULT_POLICY } from '@/quota/domain/policy.ts';

const mockClock: Clock = {
  now: () => new Date('2026-06-01T00:00:00Z'),
};

const mockIdGen: IdGenerator = {
  uuidv7: () => '018f0000-0000-7000-8000-000000000001',
};

describe('RealQuota.remainingTokens', () => {
  it('falls back to resolved policy when the period account is not yet created', async () => {
    const mockAccounts: Partial<QuotaAccountRepository> = {
      findCurrentAccount: async () => null,
    };
    const mockPolicies: Partial<QuotaPolicyRepository> = {
      findPolicy: async (scope) => {
        if (scope === 'global') {
          return {
            scope: 'global',
            divisionId: null,
            userId: null,
            monthlyTokens: 50_000,
            maxInputTokensPerRequest: null,
            maxOutputTokensPerRequest: null,
            maxConcurrentGenerations: null,
            allowedModelIds: null,
          };
        }
        return null;
      },
    };
    const mockUsage: Partial<UsageRepository> = {
      userDivisionId: async () => null,
    };

    const quota = new RealQuota({
      accounts: mockAccounts as QuotaAccountRepository,
      policies: mockPolicies as QuotaPolicyRepository,
      usage: mockUsage as UsageRepository,
      clock: mockClock,
      idGen: mockIdGen,
      quotaTimezone: 'Asia/Jakarta',
    });

    const remaining = await quota.remainingTokens('user-1');
    expect(remaining).toBe(50_000);
  });

  it('falls back to platform defaults when no policy rows exist', async () => {
    const mockAccounts: Partial<QuotaAccountRepository> = {
      findCurrentAccount: async () => null,
    };
    const mockPolicies: Partial<QuotaPolicyRepository> = {
      findPolicy: async () => null,
    };
    const mockUsage: Partial<UsageRepository> = {
      userDivisionId: async () => null,
    };

    const quota = new RealQuota({
      accounts: mockAccounts as QuotaAccountRepository,
      policies: mockPolicies as QuotaPolicyRepository,
      usage: mockUsage as UsageRepository,
      clock: mockClock,
      idGen: mockIdGen,
      quotaTimezone: 'Asia/Jakarta',
    });

    const remaining = await quota.remainingTokens('user-1');
    expect(remaining).toBe(PLATFORM_DEFAULT_POLICY.monthlyTokens);
  });

  it('computes remaining balance from active account when present', async () => {
    const mockAccounts: Partial<QuotaAccountRepository> = {
      findCurrentAccount: async () => ({
        id: 'acc-1',
        userId: 'user-1',
        scopeType: 'total',
        scopeId: null,
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-07-01T00:00:00Z'),
        baseLimitTokens: 100_000,
        adjustmentTokens: 10_000,
        usedTokens: 40_000,
        reservedTokens: 20_000,
        limits: {},
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      }),
    };
    const mockPolicies: Partial<QuotaPolicyRepository> = {
      findPolicy: async () => null,
    };
    const mockUsage: Partial<UsageRepository> = {
      userDivisionId: async () => null,
    };

    const quota = new RealQuota({
      accounts: mockAccounts as QuotaAccountRepository,
      policies: mockPolicies as QuotaPolicyRepository,
      usage: mockUsage as UsageRepository,
      clock: mockClock,
      idGen: mockIdGen,
      quotaTimezone: 'Asia/Jakarta',
    });

    // 100k + 10k - 40k - 20k = 50k
    const remaining = await quota.remainingTokens('user-1');
    expect(remaining).toBe(50_000);
  });
});

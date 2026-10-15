import { getLogger } from '@/observability/logger.ts';
import { withTransaction, type TransactionContext } from '@/db/tx.ts';
import type { Clock, IdGenerator } from '@/clock/index.ts';
import { periodEndFor, periodStartFor } from '@/quota/domain/timezone.ts';
import { PLATFORM_DEFAULT_POLICY, type ResolvedPolicy } from '@/quota/domain/policy.ts';
import type { QuotaAccountRepository } from '@/quota/ports/quota-account-repository.ts';

export interface PrecreatePeriodsHandlerDeps {
  readonly accounts: QuotaAccountRepository;
  readonly userIds: () => Promise<readonly string[]>;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly quotaTimezone: string;
  readonly resolvePolicyForUser?: ((userId: string, tx?: TransactionContext) => Promise<ResolvedPolicy>) | undefined;
}

export function createPrecreatePeriodsHandler(deps: PrecreatePeriodsHandlerDeps) {
  return async (): Promise<{ created: number; skipped: number }> => {
    const now = deps.clock.now();
    const periodStart = periodStartFor(now, deps.quotaTimezone);
    const periodEnd = periodEndFor(now, deps.quotaTimezone);
    const userIds = await deps.userIds();

    let created = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const existing = await deps.accounts.findCurrentAccount(userId, now);
      if (existing !== null) {
        skipped++;
        continue;
      }
      await withTransaction(async (tx) => {
        const policy = deps.resolvePolicyForUser
          ? await deps.resolvePolicyForUser(userId, tx)
          : PLATFORM_DEFAULT_POLICY;

        await deps.accounts.getOrCreateAccount(
          {
            id: deps.idGen.uuidv7(),
            userId,
            periodStart,
            periodEnd,
            baseLimitTokens: policy.monthlyTokens,
            limits: {
              maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
              maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
              maxConcurrentGenerations: policy.maxConcurrentGenerations,
            },
          },
          tx,
        );
      });
      created++;
    }
    getLogger().info(
      { created, skipped, periodStart: periodStart.toISOString() },
      'quota period pre-creation finished',
    );
    return { created, skipped };
  };
}

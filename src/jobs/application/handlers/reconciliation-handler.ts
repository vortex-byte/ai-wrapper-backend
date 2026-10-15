import { getLogger } from '@/observability/logger.ts';
import { withTransaction } from '@/db/tx.ts';
import type { Clock } from '@/clock/index.ts';
import type { QuotaAccountRepository } from '@/quota/ports/quota-account-repository.ts';

async function pingDb(): Promise<void> {
  await withTransaction(async () => {});
}

export interface ReconciliationHandlerDeps {
  readonly accounts: QuotaAccountRepository;
  readonly clock: Clock;
}

export function createReconciliationHandler(deps: ReconciliationHandlerDeps) {
  return async (): Promise<{
    checked: number;
    mismatches: readonly {
      accountId: string;
      userId: string;
      kind: 'used' | 'adjustment' | 'reserved';
      expected: number;
      actual: number;
    }[];
  }> => {
    const now = deps.clock.now();
    const accounts = await deps.accounts.listCurrentAccounts(now, 10_000);
    const mismatches: {
      accountId: string;
      userId: string;
      kind: 'used' | 'adjustment' | 'reserved';
      expected: number;
      actual: number;
    }[] = [];

    for (const account of accounts) {
      const totals = await deps.accounts.reconciliationTotals(account.id);
      const expectedUsed = totals.ledgerUsedTokens - totals.liveReservedTokens;

      if (account.usedTokens !== expectedUsed) {
        mismatches.push({
          accountId: account.id,
          userId: account.userId,
          kind: 'used',
          expected: expectedUsed,
          actual: account.usedTokens,
        });
      }
      if (account.adjustmentTokens !== totals.ledgerAdjustmentTokens) {
        mismatches.push({
          accountId: account.id,
          userId: account.userId,
          kind: 'adjustment',
          expected: totals.ledgerAdjustmentTokens,
          actual: account.adjustmentTokens,
        });
      }
      if (account.reservedTokens !== totals.liveReservedTokens) {
        mismatches.push({
          accountId: account.id,
          userId: account.userId,
          kind: 'reserved',
          expected: totals.liveReservedTokens,
          actual: account.reservedTokens,
        });
      }
    }

    for (const mismatch of mismatches) {
      getLogger().error(
        { ...mismatch },
        'quota reconciliation mismatch: counters diverge from the ledger',
      );
    }
    if (mismatches.length > 0) {
      getLogger().error(
        { count: mismatches.length },
        'quota reconciliation finished with mismatches; compensating ledger entries needed',
      );
    }

    await pingDb();

    return { checked: accounts.length, mismatches };
  };
}

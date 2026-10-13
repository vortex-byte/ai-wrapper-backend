import type { TransactionContext } from '@/db/tx.ts';
import { getLogger } from '@/observability/logger.ts';
import type { QuotaPort, ReservationHandle, ReserveContext, Settlement } from '../ports/quota-port.ts';

/**
 * Phase-2 quota seam: accepts every reservation and consumes nothing.
 *
 * This is deliberately **not** a "fail open" security decision — the enforcement machinery
 * (policies, accounts, ledger, concurrency caps) is Phase 3 and its tables already exist
 * (migration 0010). Building it here would drag PRD §11.2–11.10 and the §23.2 concurrency suite
 * into a phase whose gate is streaming and crash safety.
 *
 * `settleOrRelease` still logs at debug so the reserve→settle wiring is observable while the
 * real accounting is missing; it performs no writes (there is no `quota_accounts` row to update).
 */
export class NoopQuota implements QuotaPort {
  async reserve(ctx: ReserveContext, _tx: TransactionContext): Promise<ReservationHandle> {
    return {
      generationId: ctx.generationId,
      reservedTokens: 0,
      accountId: null,
    };
  }

  async settleOrRelease(settlement: Settlement, _tx: TransactionContext): Promise<void> {
    getLogger().debug(
      {
        generationId: settlement.generationId,
        outcome: settlement.outcome,
        actualTokens: settlement.actualTokens,
      },
      'quota settlement skipped (Phase 2 noop; enforcement lands in Phase 3)',
    );
  }

  async remainingTokens(_userId: string): Promise<number | null> {
    return null;
  }
}

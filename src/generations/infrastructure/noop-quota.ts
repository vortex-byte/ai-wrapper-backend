import type { TransactionContext } from '@/db/tx.ts';
import { getLogger } from '@/observability/logger.ts';
import type {
  QuotaPort,
  ReservationHandle,
  ReserveContext,
  Settlement,
} from '../ports/quota-port.ts';

export class NoopQuota implements QuotaPort {
  async reserve(ctx: ReserveContext, _tx: TransactionContext): Promise<ReservationHandle> {
    return {
      generationId: ctx.generationId,
      reservedTokens: 0,
      accountId: null,
      effectiveMaxOutputTokens: null,
      remainingTokens: null,
    };
  }

  async settleOrRelease(settlement: Settlement, _tx: TransactionContext): Promise<void> {
    getLogger().debug(
      {
        generationId: settlement.generationId,
        outcome: settlement.outcome,
        actualTokens: settlement.actualTokens,
      },
      'quota settlement recorded by noop quota implementation',
    );
  }

  async remainingTokens(_userId: string): Promise<number | null> {
    return null;
  }
}

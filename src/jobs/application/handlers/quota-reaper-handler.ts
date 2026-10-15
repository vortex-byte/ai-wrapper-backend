import type { Finalizer } from '@/generations/application/finalizer.ts';
import { getLogger } from '@/observability/logger.ts';
import { withTransaction } from '@/db/tx.ts';
import type { Clock } from '@/clock/index.ts';
import type { QuotaAccountRepository } from '@/quota/ports/quota-account-repository.ts';

export interface QuotaReaperHandlerDeps {
  readonly accounts: QuotaAccountRepository;
  readonly finalizer: Finalizer;
  readonly clock: Clock;
}

/**
 * Sweeps active reservations past their expiration timestamp.
 */
export function createQuotaReaperHandler(deps: QuotaReaperHandlerDeps) {
  return async (): Promise<{ reapedCount: number; expiredCount: number }> => {
    const now = deps.clock.now();
    const expired = await deps.accounts.findExpiredActiveReservations(now, 100);

    if (expired.length === 0) return { reapedCount: 0, expiredCount: 0 };

    let reapedCount = 0;
    let expiredCount = 0;
    for (const reservation of expired) {
      try {
        const finalized = await deps.finalizer.finalize({
          generationId: reservation.generationId,
          status: 'failed',
          finishReason: 'interrupted',
          accumulatedText: '',
          error: {
            code: 'generation_interrupted',
            message: 'Generation exceeded its maximum duration.',
            retryable: false,
          },
        });
        if (finalized) {
          reapedCount++;
        } else {
          // If generation is already terminal, expire the active reservation in its own transaction.
          await withTransaction(async (tx) => {
            const locked = await deps.accounts.lockReservationForGeneration(
              reservation.generationId,
              tx,
            );
            if (locked !== null && locked.status === 'active') {
              const account = await deps.accounts.applySettlement(
                locked.accountId,
                locked.reservedTokens,
                0,
                tx,
              );
              await deps.accounts.finalizeReservation(
                locked.generationId,
                'expired',
                null,
                deps.clock.now(),
                tx,
              );
              await deps.accounts.appendLedger(
                {
                  userId: locked.userId,
                  accountId: locked.accountId,
                  generationId: locked.generationId,
                  entryType: 'expire_release',
                  tokensDelta: -locked.reservedTokens,
                  usedAfter: account?.usedTokens ?? 0,
                  reservedAfter: account?.reservedTokens ?? 0,
                },
                tx,
              );
              expiredCount++;
            }
          });
        }
      } catch (err) {
        getLogger().error(
          { err, generationId: reservation.generationId },
          'quota reaper failed to process expired reservation',
        );
      }
    }
    return { reapedCount, expiredCount };
  };
}

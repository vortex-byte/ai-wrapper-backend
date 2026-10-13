/**
 * The quota seam (decision D1).
 *
 * Phase 2 exercises the *shape* of T1 reserve / T2 settle+release without owning the accounting:
 * the send transaction calls `reserve()` and the finalizer calls `settleOrRelease()`. Phase 3
 * swaps the implementation for conditional-UPDATE accounting (AGENTS §6.12) and nothing above
 * this port changes — which is why it exists now rather than in Phase 3.
 *
 * Rules the real implementation (Phase 3) must keep:
 * - `reserve` runs **inside** the T1 transaction, after the idempotency claim, and may throw
 *   `AppError('quota_exceeded')` / `AppError('concurrency_limit')` to roll the whole send back;
 * - `settleOrRelease` is idempotent per generation: a reservation already finalized is a no-op;
 * - neither opens its own transaction (both receive the caller's `TransactionContext`).
 */

import type { TransactionContext } from '@/db/tx.ts';

export interface ReserveContext {
  readonly userId: string;
  readonly generationId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Estimated input tokens + worst-case output, pre-multiplied by model `quota_weight`. */
  readonly requestedTokens: number;
  /** Input tokens the context builder estimated (stored on the reservation for §11.2 reporting). */
  readonly estimatedInputTokens: number;
}

/** Opaque handle handed from `reserve()` to `settleOrRelease()`; Phase 3 carries the account id. */
export interface ReservationHandle {
  readonly generationId: string;
  readonly reservedTokens: number;
  readonly accountId: string | null;
}

/** Terminal accounting for a generation: `actualTokens = 0` means "release, did not consume". */
export interface Settlement {
  readonly generationId: string;
  readonly outcome: 'settled' | 'released';
  readonly actualTokens: number;
}

export interface QuotaPort {
  /** Reserve quota for a new generation inside T1. Throws `AppError` on rejection. */
  reserve(ctx: ReserveContext, tx: TransactionContext): Promise<ReservationHandle>;

  /** Settle (consume) or release (give back) the reservation, keyed by generation. Idempotent. */
  settleOrRelease(settlement: Settlement, tx: TransactionContext): Promise<void>;

  /**
   * Live "tokens remaining" for a user, for the 202 body / `GET /generations/:id`.
   * Phase 2 has no accounts → `null` (API_CONTRACTS §6.2/§7.1 mark this nullable).
   */
  remainingTokens(userId: string): Promise<number | null>;
}

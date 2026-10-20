/**
 * Quota accounting port: reservation inside send transactions, idempotent settlement and release
 * at finalization.
 */

import type { TransactionContext } from '@/db/tx.ts';

export interface ReserveContext {
  readonly userId: string;
  readonly generationId: string;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Raw estimated input tokens from the context builder before estimation margin is applied.
   */
  readonly estimatedInputTokens: number;
  /** Worst-case output requested for this call (already clamped to model caps by the caller). */
  readonly requestedMaxOutputTokens: number;
  /** Model hard cap (`ai_models.max_output_tokens`) for the clamp math. */
  readonly modelMaxOutputTokens: number;
  /** `ai_models.quota_weight` (default 1.0). */
  readonly quotaWeight: number;
  /** Per-model margin override from `models.config.estimation.margin`, when configured. */
  readonly marginOverride?: number | undefined;
  /** True when the request carries image/document parts (heavier estimation uncertainty). */
  readonly hasMediaParts: boolean;
  /** The client opted into provider-side image generation for this turn. */
  readonly imageGeneration?: boolean | undefined;
  /** Model context cap for per-request input token validation. */
  readonly maxInputTokensForRequest?: number | undefined;
}

export interface ReservationHandle {
  readonly generationId: string;
  readonly reservedTokens: number;
  readonly accountId: string | null;
  /**
   * Effective output bound after clamping; reduced when remaining quota is low.
   */
  readonly effectiveMaxOutputTokens: number | null;
  /** Quota tokens still available after this reservation. */
  readonly remainingTokens: number | null;
}

/** Terminal accounting for a generation: `actualTokens = 0` means "release, did not consume". */
export interface Settlement {
  readonly generationId: string;
  readonly outcome: 'settled' | 'released';
  /** Raw provider tokens (input + output). Multiplied by `quota_weight` by the implementation. */
  readonly actualTokens: number;
  /** Usage breakdown for `usage_events` (optional: absent ⇒ raw actualTokens only). */
  readonly usage?:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cachedInputTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
        readonly source: 'provider' | 'estimated';
      }
    | undefined;
  readonly outcomeCategory?: 'completed' | 'cancelled' | 'failed' | undefined;
  readonly errorCategory?: string | null | undefined;
  readonly durationMs?: number | null | undefined;
  readonly timeToFirstTokenMs?: number | null | undefined;
}

export interface QuotaPort {
  /** Reserve quota for a new generation. Throws `AppError` on rejection. */
  reserve(ctx: ReserveContext, tx: TransactionContext): Promise<ReservationHandle>;

  /** Settle (consume) or release (give back) the reservation, keyed by generation. Idempotent. */
  settleOrRelease(settlement: Settlement, tx: TransactionContext): Promise<void>;

  /**
   * Live tokens remaining for a user. Returns null when no current-period account exists.
   */
  remainingTokens(userId: string): Promise<number | null>;
}

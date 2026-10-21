export const MIN_USEFUL_OUTPUT = 256;

export type MarginConfidence = 'exact' | 'approx';

export const MARGIN_EXACT = 1.0;
export const MARGIN_APPROX = 1.1;
export const MARGIN_MEDIA = 1.25;

export interface ReservationMathInput {
  readonly estimatedInputTokens: number;
  readonly hasMediaParts: boolean;
  readonly requestedMaxOutputTokens: number;
  readonly modelMaxOutputTokens: number;
  readonly quotaWeight: number;
  readonly limitTokens: number;
  readonly usedTokens: number;
  readonly reservedTokens: number;
  readonly maxOutputTokensPerRequest: number;
  readonly marginOverride?: number | undefined;
  /** Fixed synthetic token tariff reserved up front for tool work. */
  readonly toolTokens?: number | undefined;
}

export type ReservationDecision =
  | { readonly kind: 'exceeds_input_cap' }
  | { readonly kind: 'quota_exhausted'; readonly remainingTokens: number }
  | {
      readonly kind: 'reserve';
      readonly estInputTokens: number;
      readonly effectiveMaxOutputTokens: number;
      readonly reservedTokens: number;
      readonly remainingAfterReserve: number;
    };

export function computeReservation(input: ReservationMathInput): ReservationDecision {
  const margin = input.marginOverride ?? (input.hasMediaParts ? MARGIN_MEDIA : MARGIN_EXACT);
  const estInputTokens = Math.ceil(input.estimatedInputTokens * margin);
  const toolTokens = input.toolTokens ?? 0;

  const remaining = input.limitTokens - input.usedTokens - input.reservedTokens;
  const maxAffordableRaw = Math.floor(remaining / input.quotaWeight);

  if (maxAffordableRaw < estInputTokens + toolTokens + MIN_USEFUL_OUTPUT) {
    return { kind: 'quota_exhausted', remainingTokens: Math.max(0, remaining) };
  }

  const requestedOutput = Math.min(
    input.requestedMaxOutputTokens,
    input.modelMaxOutputTokens,
    input.maxOutputTokensPerRequest,
  );
  const affordableOutput = Math.max(0, maxAffordableRaw - estInputTokens - toolTokens);
  const effectiveMaxOutputTokens = Math.min(requestedOutput, affordableOutput);

  const reserveRaw = estInputTokens + effectiveMaxOutputTokens + toolTokens;
  const reservedTokens = Math.ceil(reserveRaw * input.quotaWeight);

  return {
    kind: 'reserve',
    estInputTokens,
    effectiveMaxOutputTokens,
    reservedTokens,
    remainingAfterReserve: remaining - reservedTokens,
  };
}

export function toQuotaTokens(rawTokens: number, quotaWeight: number): number {
  return Math.ceil(rawTokens * quotaWeight);
}

export function overshootTokens(actualQuotaTokens: number, reservedTokens: number): number {
  return Math.max(0, actualQuotaTokens - reservedTokens);
}

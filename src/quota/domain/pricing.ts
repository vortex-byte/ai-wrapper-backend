/**
 * Effective-dated cost estimation.
 */

export interface ModelPriceRow {
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cachedInputMicrosPerMtok: number | null;
  readonly currency: string;
}

/**
 * Micro-USD cost for a settled generation. Cached input is billed at the (cheaper) cached rate
 * when the price row publishes one, otherwise at the normal input rate.
 */
export function costMicros(
  price: ModelPriceRow,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number | null | undefined,
): number {
  const cached = cachedInputTokens ?? 0;
  const normalInput = Math.max(0, inputTokens - cached);
  const cachedRate = price.cachedInputMicrosPerMtok ?? price.inputMicrosPerMtok;
  const micros =
    (normalInput * price.inputMicrosPerMtok +
      cached * cachedRate +
      outputTokens * price.outputMicrosPerMtok) /
    1_000_000;
  return Math.ceil(micros);
}

/** Pick the price row effective at (or latest before) `instant` from rows sorted by effectiveFrom asc. */
export function effectivePriceAt(
  rows: readonly (ModelPriceRow & { readonly effectiveFrom: Date })[],
  instant: Date,
): (ModelPriceRow & { readonly effectiveFrom: Date }) | null {
  let best: (ModelPriceRow & { readonly effectiveFrom: Date }) | null = null;
  for (const row of rows) {
    if (row.effectiveFrom.getTime() <= instant.getTime()) {
      if (best === null || row.effectiveFrom.getTime() >= best.effectiveFrom.getTime()) {
        best = row;
      }
    }
  }
  return best;
}

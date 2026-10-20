import { describe, expect, it } from 'vitest';
import {
  computeReservation,
  MARGIN_APPROX,
  MARGIN_MEDIA,
  MIN_USEFUL_OUTPUT,
  overshootTokens,
  toQuotaTokens,
} from '@/quota/domain/clamping.ts';
import {
  resolvePolicy,
  PLATFORM_DEFAULT_POLICY,
  type QuotaPolicyRow,
} from '@/quota/domain/policy.ts';
import { checkToolQuota, toolTariff } from '@/quota/domain/tariffs.ts';
import { costMicros, effectivePriceAt, type ModelPriceRow } from '@/quota/domain/pricing.ts';

const baseReservation = {
  estimatedInputTokens: 1_000,
  hasMediaParts: false,
  requestedMaxOutputTokens: 8_000,
  modelMaxOutputTokens: 8_192,
  quotaWeight: 1,
  limitTokens: 500_000,
  usedTokens: 0,
  reservedTokens: 0,
  maxOutputTokensPerRequest: 16_000,
};

describe('computeReservation', () => {
  it('reserves est_input + worst-case output', () => {
    const decision = computeReservation(baseReservation);
    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      expect(decision.estInputTokens).toBe(1_000);
      expect(decision.effectiveMaxOutputTokens).toBe(8_000);
      expect(decision.reservedTokens).toBe(9_000);
    }
  });

  it('adds the image-generation tariff to the reservation', () => {
    const tariff = toolTariff('image_generation')?.tokens ?? 0;
    const decision = computeReservation({ ...baseReservation, toolTokens: tariff });

    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      expect(decision.reservedTokens).toBe(9_000 + tariff);
    }
  });

  it('rejects an image turn when the remaining quota cannot cover the tariff', () => {
    const tariff = toolTariff('image_generation')?.tokens ?? 0;
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 1_000 + tariff + MIN_USEFUL_OUTPUT - 1,
      toolTokens: tariff,
    });

    expect(decision.kind).toBe('quota_exhausted');
  });

  it('applies the media margin when image/document parts are present', () => {
    const decision = computeReservation({ ...baseReservation, hasMediaParts: true });
    if (decision.kind === 'reserve') {
      expect(decision.estInputTokens).toBe(Math.ceil(1_000 * MARGIN_MEDIA));
    }
  });

  it('applies the margin override from model config when present', () => {
    const decision = computeReservation({ ...baseReservation, marginOverride: MARGIN_APPROX });
    if (decision.kind === 'reserve') {
      expect(decision.estInputTokens).toBe(1_100);
    }
  });

  it('multiplies by quota_weight and rounds up', () => {
    const decision = computeReservation({ ...baseReservation, quotaWeight: 1.25 });
    if (decision.kind === 'reserve') {
      expect(decision.reservedTokens).toBe(Math.ceil(9_000 * 1.25));
    }
  });

  it('rejects when remaining quota cannot cover a useful answer', () => {
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 1_200,
    });
    expect(decision.kind).toBe('quota_exhausted');
    if (decision.kind === 'quota_exhausted') {
      expect(decision.remainingTokens).toBe(1_200);
    }
  });

  it('clamps output to remaining quota so the user can spend their last tokens', () => {
    // remaining = 5,000; est input 1,000 → output clamped to 4,000 (≥ MIN_USEFUL_OUTPUT).
    const decision = computeReservation({ ...baseReservation, limitTokens: 5_000 });
    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      expect(decision.effectiveMaxOutputTokens).toBe(4_000);
      expect(decision.reservedTokens).toBe(5_000);
      expect(decision.remainingAfterReserve).toBe(0);
    }
  });

  it('shrunk output stays at least MIN_USEFUL_OUTPUT above the input, else reject', () => {
    // remaining = 1,000 + MIN_USEFUL_OUTPUT - 1 → cannot fit input + 256 output.
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 1_000 + MIN_USEFUL_OUTPUT - 1,
    });
    expect(decision.kind).toBe('quota_exhausted');
  });

  it('never reserves more than the per-request output cap', () => {
    const decision = computeReservation({
      ...baseReservation,
      requestedMaxOutputTokens: 50_000,
      maxOutputTokensPerRequest: 8_000,
    });
    if (decision.kind === 'reserve') {
      expect(decision.effectiveMaxOutputTokens).toBe(8_000);
    }
  });

  it('accounts for existing usage and other live reservations in remaining', () => {
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 10_000,
      usedTokens: 6_000,
      reservedTokens: 2_000,
    });
    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      // remaining 2,000 − est input 1,000 → output clamped to 1,000.
      expect(decision.effectiveMaxOutputTokens).toBe(1_000);
    }
  });

  it('correctly dimensions output clamping when quotaWeight is greater than 1.0', () => {
    // remaining = 3,000 quota tokens, quotaWeight = 2.0 -> maxAffordableRaw = 1,500
    // estInputTokens = 1,000 -> affordable output = 500 raw tokens
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 3_000,
      quotaWeight: 2.0,
    });
    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      expect(decision.effectiveMaxOutputTokens).toBe(500);
      expect(decision.reservedTokens).toBe(3_000); // (1000 + 500) * 2.0
      expect(decision.remainingAfterReserve).toBe(0);
    }
  });

  it('correctly dimensions output clamping when quotaWeight is less than 1.0', () => {
    // remaining = 1,000 quota tokens, quotaWeight = 0.5 -> maxAffordableRaw = 2,000
    // estInputTokens = 1,000 -> affordable output = 1,000 raw tokens
    const decision = computeReservation({
      ...baseReservation,
      limitTokens: 1_000,
      quotaWeight: 0.5,
      requestedMaxOutputTokens: 4_000,
    });
    expect(decision.kind).toBe('reserve');
    if (decision.kind === 'reserve') {
      expect(decision.effectiveMaxOutputTokens).toBe(1_000);
      expect(decision.reservedTokens).toBe(1_000); // (1000 + 1000) * 0.5
      expect(decision.remainingAfterReserve).toBe(0);
    }
  });
});

describe('settlement math', () => {
  it('toQuotaTokens multiplies by weight and rounds up', () => {
    expect(toQuotaTokens(10_001, 1)).toBe(10_001);
    expect(toQuotaTokens(1_000, 1.5)).toBe(1_500);
    expect(toQuotaTokens(1_001, 1.5)).toBe(1_502);
  });

  it('overshootTokens is never negative', () => {
    expect(overshootTokens(12_000, 9_000)).toBe(3_000);
    expect(overshootTokens(5_000, 9_000)).toBe(0);
  });
});

describe('policy resolution', () => {
  const global: QuotaPolicyRow = {
    scope: 'global',
    divisionId: null,
    userId: null,
    monthlyTokens: 500_000,
    maxInputTokensPerRequest: 100_000,
    maxOutputTokensPerRequest: 8_000,
    maxConcurrentGenerations: 2,
    allowedModelIds: null,
  };

  it('falls back to global when no user/division policies exist', () => {
    expect(resolvePolicy(null, null, global)).toEqual({
      monthlyTokens: 500_000,
      maxInputTokensPerRequest: 100_000,
      maxOutputTokensPerRequest: 8_000,
      maxConcurrentGenerations: 2,
      allowedModelIds: null,
    });
  });

  it('resolves per field: user overrides monthly only, rest inherit', () => {
    const user: QuotaPolicyRow = {
      scope: 'user',
      divisionId: null,
      userId: 'u1',
      monthlyTokens: 2_000_000,
      maxInputTokensPerRequest: null,
      maxOutputTokensPerRequest: null,
      maxConcurrentGenerations: null,
      allowedModelIds: null,
    };
    const resolved = resolvePolicy(user, null, global);
    expect(resolved.monthlyTokens).toBe(2_000_000);
    expect(resolved.maxInputTokensPerRequest).toBe(100_000);
    expect(resolved.maxConcurrentGenerations).toBe(2);
  });

  it('division overrides global, user overrides division', () => {
    const division: QuotaPolicyRow = {
      scope: 'division',
      divisionId: 'd1',
      userId: null,
      monthlyTokens: 1_000_000,
      maxInputTokensPerRequest: null,
      maxOutputTokensPerRequest: 4_000,
      maxConcurrentGenerations: 5,
      allowedModelIds: null,
    };
    const user: QuotaPolicyRow = {
      scope: 'user',
      divisionId: null,
      userId: 'u1',
      monthlyTokens: null,
      maxInputTokensPerRequest: null,
      maxOutputTokensPerRequest: null,
      maxConcurrentGenerations: 1,
      allowedModelIds: null,
    };
    const resolved = resolvePolicy(user, division, global);
    expect(resolved.monthlyTokens).toBe(1_000_000); // division
    expect(resolved.maxOutputTokensPerRequest).toBe(4_000); // division
    expect(resolved.maxConcurrentGenerations).toBe(1); // user
    expect(resolved.maxInputTokensPerRequest).toBe(100_000); // global
  });

  it('uses platform defaults when every scope is empty', () => {
    expect(resolvePolicy(null, null, null)).toEqual(PLATFORM_DEFAULT_POLICY);
  });
});

describe('tool tariffs', () => {
  it('prices image generation and search grounding', () => {
    expect(toolTariff('image_generation')?.tokens).toBe(3_500);
    expect(toolTariff('web_search')?.tokens).toBe(500);
  });

  it('allows token-native (unknown) tools unconditionally', () => {
    const verdict = checkToolQuota('code_execution', 0);
    expect(verdict.allowed).toBe(true);
  });

  it('blocks the tariffed tool when remaining quota is short', () => {
    expect(checkToolQuota('image_generation', 3_499).allowed).toBe(false);
    expect(checkToolQuota('image_generation', 3_500).allowed).toBe(true);
  });
});

describe('cost micros', () => {
  const price: ModelPriceRow = {
    inputMicrosPerMtok: 3_000_000, // $3 / Mtok
    outputMicrosPerMtok: 15_000_000, // $15 / Mtok
    cachedInputMicrosPerMtok: 300_000,
    currency: 'USD',
  };

  it('bills normal input at input rate and output at output rate', () => {
    // (1M input + 0.1M output) → 3_000_000 + 1_500_000 micros
    expect(costMicros(price, 1_000_000, 100_000, null)).toBe(4_500_000);
  });

  it('bills cached input at the cached rate', () => {
    // 900k normal + 100k cached → 2_700_000 + 30_000 + 0
    expect(costMicros(price, 1_000_000, 0, 100_000)).toBe(2_730_000);
  });

  it('falls back to the input rate when no cached rate is published', () => {
    const noCached: ModelPriceRow = { ...price, cachedInputMicrosPerMtok: null };
    expect(costMicros(noCached, 1_000_000, 0, 100_000)).toBe(3_000_000);
  });

  it('effectivePriceAt picks the latest effective row at or before the instant', () => {
    const rows = [
      { effectiveFrom: new Date('2026-01-01T00:00:00Z'), ...price },
      { effectiveFrom: new Date('2026-06-01T00:00:00Z'), ...price },
    ];
    expect(effectivePriceAt(rows, new Date('2026-05-15T00:00:00Z'))?.effectiveFrom).toEqual(
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(effectivePriceAt(rows, new Date('2026-07-15T00:00:00Z'))?.effectiveFrom).toEqual(
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(effectivePriceAt(rows, new Date('2025-12-31T00:00:00Z'))).toBeNull();
  });
});

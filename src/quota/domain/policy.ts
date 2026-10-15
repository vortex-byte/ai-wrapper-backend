/**
 * Quota policy resolution.
 *
 * Policies exist at three scopes: user, division, and global.
 * Resolution is per field: user → division → global → platform default.
 */

export interface QuotaPolicyRow {
  readonly scope: 'global' | 'division' | 'user';
  readonly divisionId: string | null;
  readonly userId: string | null;
  readonly monthlyTokens: number | null;
  readonly maxInputTokensPerRequest: number | null;
  readonly maxOutputTokensPerRequest: number | null;
  readonly maxConcurrentGenerations: number | null;
  readonly allowedModelIds: readonly string[] | null;
}

export interface ResolvedPolicy {
  readonly monthlyTokens: number;
  readonly maxInputTokensPerRequest: number;
  readonly maxOutputTokensPerRequest: number;
  readonly maxConcurrentGenerations: number;
  readonly allowedModelIds: readonly string[] | null;
}

/**
 * Platform defaults used when a policy field is not configured at any scope.
 */
export const PLATFORM_DEFAULT_POLICY: ResolvedPolicy = {
  monthlyTokens: 500_000,
  maxInputTokensPerRequest: 190_000,
  maxOutputTokensPerRequest: 16_000,
  maxConcurrentGenerations: 2,
  allowedModelIds: null,
};

/**
 * Resolve a user's effective policy. `userPolicy`/`divisionPolicy` may be null (no row at that
 * scope); `globalPolicy` may also be null (no global row yet) — then platform defaults apply.
 */
export function resolvePolicy(
  userPolicy: QuotaPolicyRow | null,
  divisionPolicy: QuotaPolicyRow | null,
  globalPolicy: QuotaPolicyRow | null,
): ResolvedPolicy {
  const layers: readonly (QuotaPolicyRow | null)[] = [userPolicy, divisionPolicy, globalPolicy];
  const pick = <K extends keyof ResolvedPolicy>(field: K): ResolvedPolicy[K] | null => {
    for (const layer of layers) {
      const value = layer?.[field as keyof QuotaPolicyRow];
      if (value !== null && value !== undefined) return value as ResolvedPolicy[K];
    }
    return null;
  };

  const resolved: ResolvedPolicy = {
    monthlyTokens: pick('monthlyTokens') ?? PLATFORM_DEFAULT_POLICY.monthlyTokens,
    maxInputTokensPerRequest:
      pick('maxInputTokensPerRequest') ?? PLATFORM_DEFAULT_POLICY.maxInputTokensPerRequest,
    maxOutputTokensPerRequest:
      pick('maxOutputTokensPerRequest') ?? PLATFORM_DEFAULT_POLICY.maxOutputTokensPerRequest,
    maxConcurrentGenerations:
      pick('maxConcurrentGenerations') ?? PLATFORM_DEFAULT_POLICY.maxConcurrentGenerations,
    allowedModelIds: pick('allowedModelIds'),
  };
  return resolved;
}

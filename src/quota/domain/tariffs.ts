/** Fixed synthetic token tariffs for external non-token actions. */

export interface ToolTariff {
  readonly tokens: number;
  readonly reason: string;
}

export const TOOL_TOKEN_TARIFF: Readonly<Record<string, ToolTariff>> = {
  image_generation: { tokens: 3_500, reason: 'External image generation (diffusion)' },
  web_search: { tokens: 500, reason: 'Web search grounding' },
  web_fetch: { tokens: 200, reason: 'Web fetch grounding' },
};

export function toolTariff(toolName: string): ToolTariff | null {
  return TOOL_TOKEN_TARIFF[toolName] ?? null;
}

/** Verifies remaining quota against tool tariff. */
export function checkToolQuota(
  toolName: string,
  remainingTokens: number,
): { allowed: true; tariff: ToolTariff } | { allowed: false; tariff: ToolTariff } {
  const tariff = toolTariff(toolName);
  if (tariff === null) {
    return { allowed: true, tariff: { tokens: 0, reason: 'token-native tool' } };
  }
  return remainingTokens >= tariff.tokens ? { allowed: true, tariff } : { allowed: false, tariff };
}

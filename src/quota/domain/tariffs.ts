/**
 * Tool token tariffs.
 *
 * External actions (e.g. image generation, search) carry synthetic token tariffs.
 * Token-native actions (code, text) are billed via actual token consumption.
 */

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

/**
 * Quota verdict for a prospective tool call. The interceptor compares `tariff.tokens`
 * against remaining quota and either allows the call or substitutes an error tool_result.
 */
export function checkToolQuota(
  toolName: string,
  remainingTokens: number,
): { allowed: true; tariff: ToolTariff } | { allowed: false; tariff: ToolTariff } {
  const tariff = toolTariff(toolName);
  if (tariff === null) {
    return { allowed: true, tariff: { tokens: 0, reason: 'token-native tool' } };
  }
  return remainingTokens >= tariff.tokens
    ? { allowed: true, tariff }
    : { allowed: false, tariff };
}

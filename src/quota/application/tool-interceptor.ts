import { checkToolQuota, type ToolTariff } from '../domain/tariffs.ts';

/**
 * Charges a tariffed tool's token cost before the call runs; without budget the caller gets a
 * synthetic error result instead of executing the tool.
 */
export interface ToolCallVerdict {
  readonly allowed: boolean;
  readonly toolName: string;
  readonly tariff: ToolTariff;
  /** Synthetic `tool_result` content for a blocked call; `null` when allowed. */
  readonly syntheticToolResult: string | null;
}

export function interceptToolCall(
  toolName: string,
  remainingTokens: number | null,
): ToolCallVerdict {
  // No live account (never reserved this period) ⇒ zero remaining for tariffed tools.
  const verdict = checkToolQuota(toolName, remainingTokens ?? 0);
  if (verdict.allowed) {
    return {
      allowed: true,
      toolName,
      tariff: verdict.tariff,
      syntheticToolResult: null,
    };
  }
  return {
    allowed: false,
    toolName,
    tariff: verdict.tariff,
    syntheticToolResult:
      `Error: Insufficient token quota for ${verdict.tariff.reason.toLowerCase()} ` +
      `(requires ${verdict.tariff.tokens.toLocaleString('en-US')} tokens, ` +
      `remaining: ${(remainingTokens ?? 0).toLocaleString('en-US')}).`,
  };
}

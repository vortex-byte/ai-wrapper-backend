import type {
  NormalizedChatRequest,
  ReasoningEffort,
} from '@/providers/domain/capabilities.ts';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const API_VERSION = 'v1beta';
export const MAX_INLINE_BYTES = 15 * 1024 * 1024;
export const INLINE_ARTIFACT_PREFIX = 'gemini-inline:';
export const INLINE_DATA_URL_PREFIX = 'data:';

export const THINKING_BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 24576,
};

const MIN_OUTPUT_HEADROOM = 1024;

export function resolveThinkingBudget(effort: ReasoningEffort, maxOutputTokens: number): number {
  const budget = THINKING_BUDGETS[effort];
  const ceiling = maxOutputTokens - MIN_OUTPUT_HEADROOM;
  if (ceiling <= 0) return budget;
  return Math.min(budget, ceiling);
}

export const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'SPII',
  'ESCALATION',
]);

export function flag(req: NormalizedChatRequest, key: string, fallback: boolean): boolean {
  const modelValue = req.model.config[key];
  if (typeof modelValue === 'boolean') return modelValue;
  const providerValue = req.provider.config[key];
  if (typeof providerValue === 'boolean') return providerValue;
  return fallback;
}

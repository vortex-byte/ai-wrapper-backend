import type { ReasoningEffort } from '@/providers/domain/capabilities.ts';

export const DEFAULT_CODE_EXECUTION_TOOL_TYPE = 'code_execution_20250825';
export const MAX_PAUSE_TURNS = 8;
export const MIN_THINKING_BUDGET = 1024;

export const THINKING_BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16000,
};

export const DEFAULT_OUTPUT_DIR_ENV = 'OUTPUT_DIR';
export const DEFAULT_ANTHROPIC_VERSION = '2026-10-21';

export const ON_DEMAND_COMPACTION_BETA = 'compact-2026-09-04';
export const THRESHOLD_COMPACTION_BETA = 'compact-2026-01-12';
export const COMPACTION_EDIT_TYPE = 'compact_20260112';

export const MIN_COMPACTION_TRIGGER = 50_000;

export function outputDirAddendum(envVar: string): string {
  return (
    `\n\nYou have access to code execution tools. ` +
    `Choose whether to use this tool based on the user's request. ` +
    `Always copy or save all generated files (PDF, DOCX, XLSX, PPTX, images) ` +
    `directly into the directory specified by $${envVar} so they can be captured.`
  );
}

export function isModernEffortModel(apiModelId: string): boolean {
  const id = apiModelId.toLowerCase().replace(/(\d+)\.(\d+)/g, '$1-$2');
  return (
    id.includes('claude-5') ||
    id.includes('claude-4-7') ||
    id.includes('claude-4-8') ||
    id.includes('claude-4-9') ||
    id.includes('claude-fable') ||
    id.includes('claude-mythos') ||
    /claude-[a-z]+-5/i.test(id) ||
    /claude-[a-z]+-4-[7-9]/i.test(id)
  );
}

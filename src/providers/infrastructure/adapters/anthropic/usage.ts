import type { RawAnthropicStreamEvent, ReplayBlock, RunState } from './types.ts';

export function createRunState(): RunState {
  return {
    openBlocks: new Set<number>(),
    toolBlocks: new Map<number, { toolCallId: string; name: string }>(),
    blockTypes: new Map<number, string>(),
    blockText: new Map<number, string>(),
    toolInputJson: new Map<number, string>(),
    turnBlockOrder: [],
    turnBlocks: new Map<number, ReplayBlock>(),
    compactionEmittedIndices: new Set<number>(),
    inputTokens: 0,
    outputTokens: 0,
    priorTurnsOutputTokens: 0,
    iterationOutputTokens: 0,
    cachedInputTokens: undefined,
    stopReason: 'end_turn',
  };
}

export function resetTurn(runState: RunState): void {
  runState.priorTurnsOutputTokens = runState.outputTokens;
  runState.iterationOutputTokens = 0;
  runState.openBlocks.clear();
  runState.toolBlocks.clear();
  runState.blockTypes.clear();
  runState.blockText.clear();
  runState.toolInputJson.clear();
  runState.turnBlockOrder.length = 0;
  runState.turnBlocks.clear();
  runState.compactionEmittedIndices.clear();
}

export function accumulateInputUsage(runState: RunState, ev: RawAnthropicStreamEvent): void {
  let uncached = ev.message?.usage?.input_tokens ?? 0;
  let cacheRead = ev.message?.usage?.cache_read_input_tokens ?? 0;
  let cacheCreation = ev.message?.usage?.cache_creation_input_tokens ?? 0;

  const iterations = ev.message?.usage?.iterations;
  if (Array.isArray(iterations)) {
    for (const iter of iterations) {
      if (iter.type === 'compaction') {
        uncached += iter.input_tokens ?? 0;
        cacheRead += iter.cache_read_input_tokens ?? 0;
        cacheCreation += iter.cache_creation_input_tokens ?? 0;
        if (iter.output_tokens !== undefined) {
          runState.iterationOutputTokens += iter.output_tokens;
        }
      }
    }
  }

  runState.inputTokens += uncached + cacheRead + cacheCreation;
  runState.outputTokens = runState.priorTurnsOutputTokens + runState.iterationOutputTokens;
  if (cacheRead > 0) {
    runState.cachedInputTokens = (runState.cachedInputTokens ?? 0) + cacheRead;
  }
}

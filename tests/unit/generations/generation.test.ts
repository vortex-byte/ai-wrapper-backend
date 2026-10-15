import { describe, expect, it } from 'vitest';
import {
  canTransition,
  completedFromFinishReason,
  isActive,
  isTerminal,
  mapOutcome,
  type GenerationOutcome,
} from '@/generations/domain/generation.ts';

describe('generation state machine', () => {
  it('classifies live vs terminal statuses', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('generating')).toBe(false);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('failed')).toBe(true);

    expect(isActive('pending')).toBe(true);
    expect(isActive('generating')).toBe(true);
    expect(isActive('completed')).toBe(false);
  });

  it('allows only valid state transitions', () => {
    expect(canTransition('pending', 'generating')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
    expect(canTransition('generating', 'completed')).toBe(true);
    expect(canTransition('generating', 'cancelled')).toBe(true);
    expect(canTransition('generating', 'failed')).toBe(true);

    expect(canTransition('completed', 'failed')).toBe(false);
    expect(canTransition('cancelled', 'generating')).toBe(false);
    expect(canTransition('failed', 'pending')).toBe(false);

    expect(canTransition('generating', 'pending')).toBe(false);
    expect(canTransition('completed', 'pending')).toBe(false);
  });
});

describe('mapOutcome', () => {
  it('maps a completed run to a complete message and the provider finish reason', () => {
    const mapping = mapOutcome({ kind: 'completed', finishReason: 'stop' }, { hasContent: true });
    expect(mapping).toEqual({
      generationStatus: 'completed',
      messageStatus: 'complete',
      finishReason: 'stop',
      streamingPartStatus: 'complete',
      providerAccepted: true,
    });
  });

  it('carries `length` and `content_filter` through as completed outcomes', () => {
    expect(
      mapOutcome({ kind: 'completed', finishReason: 'length' }, { hasContent: true }).finishReason,
    ).toBe('length');
    expect(
      mapOutcome({ kind: 'completed', finishReason: 'content_filter' }, { hasContent: true })
        .messageStatus,
    ).toBe('complete');
  });

  it('maps a cancellation to an incomplete message with partial text kept', () => {
    const mapping = mapOutcome({ kind: 'cancelled', reason: 'user_cancel' }, { hasContent: true });
    expect(mapping.generationStatus).toBe('cancelled');
    expect(mapping.messageStatus).toBe('incomplete');
    expect(mapping.finishReason).toBe('cancelled');
    expect(mapping.streamingPartStatus).toBe('incomplete');
  });

  it('maps a failure with no content to `failed`, with content to `incomplete`', () => {
    const withoutContent = mapOutcome(
      { kind: 'failed', category: 'provider_unavailable' },
      { hasContent: false },
    );
    expect(withoutContent.generationStatus).toBe('failed');
    expect(withoutContent.messageStatus).toBe('failed');
    expect(withoutContent.finishReason).toBe('error');

    const withContent = mapOutcome(
      { kind: 'failed', category: 'provider_unavailable' },
      { hasContent: true },
    );
    expect(withContent.messageStatus).toBe('incomplete');
    expect(withContent.finishReason).toBe('error');
  });

  it('uses `timeout` as the finish reason for a generation timeout', () => {
    const mapping = mapOutcome(
      { kind: 'failed', category: 'generation_timeout' },
      { hasContent: false },
    );
    expect(mapping.finishReason).toBe('timeout');
  });

  it('maps an interrupted run to failed + incomplete', () => {
    const mapping = mapOutcome({ kind: 'interrupted' }, { hasContent: true });
    expect(mapping.generationStatus).toBe('failed');
    expect(mapping.messageStatus).toBe('incomplete');
    expect(mapping.finishReason).toBe('interrupted');
    expect(mapping.streamingPartStatus).toBe('incomplete');
  });

  it('never reports a failure with content as a hard `failed` message', () => {
    const outcomes: GenerationOutcome[] = [
      { kind: 'failed', category: 'internal_error' },
      { kind: 'failed', category: 'provider_rate_limited' },
      { kind: 'failed', category: 'content_filtered' },
      { kind: 'interrupted' },
    ];
    for (const outcome of outcomes) {
      expect(mapOutcome(outcome, { hasContent: true }).messageStatus).toBe('incomplete');
    }
  });
});

describe('completedFromFinishReason', () => {
  it('normalizes unmodelled provider reasons to `stop`', () => {
    expect(completedFromFinishReason('stop')).toBe('stop');
    expect(completedFromFinishReason('length')).toBe('length');
    expect(completedFromFinishReason('content_filter')).toBe('content_filter');
    expect(completedFromFinishReason('tool_use')).toBe('stop');
    expect(completedFromFinishReason('other')).toBe('stop');
  });
});

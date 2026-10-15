/**
 * Generation state machine and terminal outcome to status mappings.
 * Terminal states are set conditionally so concurrent events resolve deterministically.
 */

import type { FinishReason, MessageStatus, PartStatus } from '@/conversations/domain/conversation.ts';

export type GenerationStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Terminal states are final; `pending`/`generating` are the two live states. */
export const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** The live states — the ones the partial unique index ("one active per conversation") covers. */
export const ACTIVE_STATUSES = ['pending', 'generating'] as const;

export function isTerminal(status: GenerationStatus): status is TerminalStatus {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export function isActive(status: GenerationStatus): boolean {
  return status === 'pending' || status === 'generating';
}

/** Why a generation stopped while still live. */
export type CancelReason = 'user_cancel' | 'detached' | 'shutdown';

/**
 * The generation-level error category stored on `generation_jobs.error_category` and surfaced in
 * the `generation.failed` SSE frame. A subset of the platform error vocabulary — only what a
 * generation can end with.
 */
export type GenerationFailureCategory =
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'generation_timeout'
  | 'content_filtered'
  | 'incomplete'
  | 'internal_error';

/**
 * A terminal outcome derived from how the run ended. This is the single input to the mapping
 * table below; the runner, the finalizer and the reaper all produce one.
 */
export type GenerationOutcome =
  | { readonly kind: 'completed'; readonly finishReason: CompletedFinishReason }
  | { readonly kind: 'cancelled'; readonly reason: CancelReason }
  | { readonly kind: 'failed'; readonly category: GenerationFailureCategory }
  | { readonly kind: 'interrupted' };

/** The provider finish reasons that map onto a successful completion (PAL `finished`). */
export type CompletedFinishReason = 'stop' | 'length' | 'content_filter';

export interface OutcomeMapping {
  readonly generationStatus: TerminalStatus;
  readonly messageStatus: MessageStatus;
  readonly finishReason: FinishReason;
  /** Terminal status for parts that were still `streaming` when the run ended. */
  readonly streamingPartStatus: PartStatus;
  /** Whether the provider accepted the request. */
  readonly providerAccepted: boolean;
}

/**
 * Maps a generation outcome to terminal message and generation states.
 */
export function mapOutcome(
  outcome: GenerationOutcome,
  options: { readonly hasContent: boolean },
): OutcomeMapping {
  switch (outcome.kind) {
    case 'completed':
      return {
        generationStatus: 'completed',
        messageStatus: 'complete',
        finishReason: outcome.finishReason,
        streamingPartStatus: 'complete',
        providerAccepted: true,
      };
    case 'cancelled':
      return {
        generationStatus: 'cancelled',
        messageStatus: 'incomplete',
        finishReason: 'cancelled',
        streamingPartStatus: 'incomplete',
        providerAccepted: true,
      };
    case 'failed':
      // A failure with partial content is marked incomplete so partial text remains visible.
      return {
        generationStatus: 'failed',
        messageStatus: options.hasContent ? 'incomplete' : 'failed',
        finishReason: failureFinishReason(outcome.category),
        streamingPartStatus: 'failed',
        providerAccepted: outcome.category !== 'internal_error',
      };
    case 'interrupted':
      return {
        generationStatus: 'failed',
        messageStatus: 'incomplete',
        finishReason: 'interrupted',
        streamingPartStatus: 'incomplete',
        providerAccepted: true,
      };
  }
}

/** `generation_timeout` → `timeout`; everything else that ended in failure → `error`. */
function failureFinishReason(category: GenerationFailureCategory): FinishReason {
  return category === 'generation_timeout' ? 'timeout' : 'error';
}

/**
 * The live-state transitions. Returns `false` for any transition that the state machine forbids,
 * which the caller turns into "leave the row alone" (idempotency) rather than an error.
 */
export function canTransition(from: GenerationStatus, to: GenerationStatus): boolean {
  if (isTerminal(from)) return false;
  if (to === 'pending') return false;
  if (from === 'pending') return true;
  return to !== 'generating';
}

/**
 * Map a PAL `finished` reason onto a completed outcome.
 */
export function completedFromFinishReason(
  reason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other',
): CompletedFinishReason {
  if (reason === 'content_filter') return 'content_filter';
  if (reason === 'length') return 'length';
  return 'stop';
}

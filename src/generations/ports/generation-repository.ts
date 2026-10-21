import type { TransactionContext } from '@/db/tx.ts';
import type { GenerationStatus } from '../domain/generation.ts';

/** Persistence port for generation lifecycle records and idempotency keys. */

export interface GenerationRecord {
  readonly id: string;
  readonly requestId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly status: GenerationStatus;
  readonly runnerId: string | null;
  readonly cancelReason: string | null;
  readonly startedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly finishedAt: Date | null;
  readonly lastEventSeq: number;
  readonly estInputTokens: number | null;
  readonly maxOutputTokens: number;
  readonly modelLock: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly contextInfo: Readonly<Record<string, unknown>>;
  readonly errorCategory: string | null;
  readonly errorDetail: Readonly<Record<string, unknown>> | null;
  readonly providerRequestId: string | null;
  readonly providerLatencyMs: number | null;
  readonly attempt: number;
  readonly supersededBy: string | null;
  readonly createdAt: Date;
}

export interface InsertGenerationInput {
  readonly id: string;
  readonly requestId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly estInputTokens: number | null;
  readonly maxOutputTokens: number;
  readonly modelLock: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly contextInfo: Readonly<Record<string, unknown>>;
}

/** A stored idempotent response, replayed byte-for-byte on a repeat key. */
export interface StoredIdempotentResponse {
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly requestHash: string;
}

export interface CheckpointTextInput {
  readonly partId: string;
  readonly chunk: string;
  readonly generationId: string;
  readonly lastEventSeq: number;
  readonly heartbeatAt: Date;
}

export interface TransitionTerminalInput {
  readonly generationId: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly cancelReason?: string | null | undefined;
  readonly errorCategory?: string | null | undefined;
  readonly errorDetail?: Record<string, unknown> | null | undefined;
  readonly finishedAt: Date;
}

export interface StaleGenerationRow {
  readonly id: string;
  readonly assistantMessageId: string;
  readonly status: string;
}

export interface GenerationUsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly quotaTokens: number;
}

export interface GenerationRepository {
  /** Inserts a generation in pending status. */
  insert(input: InsertGenerationInput, tx: TransactionContext): Promise<GenerationRecord>;

  /**
   * Updates `max_output_tokens` on a generation row when output clamping applies.
   */
  updateMaxOutputTokens(id: string, maxOutputTokens: number, tx: TransactionContext): Promise<void>;

  /** Scoped to the owner; another user's id returns `null` (mapped to 404). */
  findByIdForUser(
    id: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<GenerationRecord | null>;

  /** System lookup by generation ID without user ownership predicate. */
  findById(id: string, tx?: TransactionContext): Promise<GenerationRecord | null>;

  checkpointText(input: CheckpointTextInput, tx?: TransactionContext): Promise<void>;

  /** Advances heartbeat timestamp to signal liveness during non-streaming phases. */
  touchHeartbeat(generationId: string, heartbeatAt: Date, tx?: TransactionContext): Promise<void>;

  /** Atomically transitions generation from live to terminal status. */
  transitionToTerminal(input: TransitionTerminalInput, tx?: TransactionContext): Promise<boolean>;

  markGenerating(id: string, startedAt: Date, tx?: TransactionContext): Promise<void>;

  findUsage(
    generationId: string,
    tx?: TransactionContext,
  ): Promise<GenerationUsageSnapshot | null>;

  findStaleGenerations(
    criteria: {
      readonly generatingHeartbeatOlderThanSeconds: number;
      readonly pendingOlderThanSeconds: number;
      readonly limit?: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly StaleGenerationRow[]>;

  /** Claims idempotency key or returns previously stored response. */
  claimIdempotencyKey(
    input: {
      readonly userId: string;
      readonly key: string;
      readonly endpoint: string;
      readonly requestHash: string;
      readonly expiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<
    | { readonly claimed: true }
    | { readonly claimed: false; readonly stored: StoredIdempotentResponse }
  >;

  /** Stores idempotent response payload for a claimed key. */
  storeIdempotentResponse(
    input: {
      readonly userId: string;
      readonly key: string;
      readonly responseStatus: number;
      readonly responseBody: unknown;
    },
    tx: TransactionContext,
  ): Promise<void>;

  countActiveForUser(userId: string, tx?: TransactionContext): Promise<number>;

  /** Count all active generations on this node/cluster — the `MAX_ACTIVE_GENERATIONS` admission check. */
  countActiveNodeWide(tx?: TransactionContext): Promise<number>;
}

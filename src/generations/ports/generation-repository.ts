import type { TransactionContext } from '@/db/tx.ts';
import type { GenerationStatus } from '../domain/generation.ts';

/**
 * Persistence for generation records.
 *
 * Writes take the caller's transaction context so mutations stay atomic
 * with associated messages and state updates.
 */

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

export interface GenerationRepository {
  /**
   * Insert a new generation in the live `pending` state. Throws on the partial unique index
   * (SQLSTATE 23505) when the conversation already has a live generation — the caller maps that to
   * `409 generation_in_progress`.
   */
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

  /**
   * Atomically transitions a generation from live ('pending' | 'generating') to terminal.
   * Returns true if this caller won the race and updated the row; false if already terminal.
   */
  transitionToTerminal(input: TransitionTerminalInput, tx?: TransactionContext): Promise<boolean>;

  markGenerating(id: string, startedAt: Date, tx?: TransactionContext): Promise<void>;

  findStaleGenerations(
    criteria: {
      readonly generatingHeartbeatOlderThanSeconds: number;
      readonly pendingOlderThanSeconds: number;
      readonly limit?: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly StaleGenerationRow[]>;

  /**
   * Claims an idempotency key. Returns `{ claimed: true }` when this caller
   * is the first to use the key, or the previously stored response when the key exists.
   */
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

  /**
   * Persist the response for an already-claimed key, so a later replay returns identical bytes.
   * Only the row owned by this user/key is updated; a no-op when nothing matches.
   */
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

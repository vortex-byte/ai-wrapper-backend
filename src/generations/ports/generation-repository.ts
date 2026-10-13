import type { TransactionContext } from '@/db/tx.ts';
import type { GenerationStatus } from '../domain/generation.ts';

/**
 * Persistence for `generation_jobs` — the generation record *and* the job record (PRD §14.6).
 *
 * Every write takes the caller's `TransactionContext`: T1 (send) must write the generation row in
 * the same transaction as the messages it belongs to, and the finalizer's T2 must be atomic with
 * its own message/part writes. Repositories never open a transaction (AGENTS §3.6).
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

  /** Scoped to the owner; another user's id returns `null` (mapped to 404). */
  findByIdForUser(
    id: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<GenerationRecord | null>;

  /** System lookup by generation ID without user ownership predicate. */
  findById(id: string, tx?: TransactionContext): Promise<GenerationRecord | null>;

  /** Checkpoints text to message part and touches heartbeat/lastEventSeq on generation (recipe T5). */
  checkpointText(input: CheckpointTextInput, tx?: TransactionContext): Promise<void>;

  /**
   * Atomically transitions a generation from live ('pending' | 'generating') to terminal (recipe T3).
   * Returns true if this caller won the race and updated the row; false if already terminal.
   */
  transitionToTerminal(input: TransitionTerminalInput, tx?: TransactionContext): Promise<boolean>;

  /** Marks a generation as actively generating in DB. */
  markGenerating(id: string, startedAt: Date, tx?: TransactionContext): Promise<void>;

  /** Sweeps generations that are abandoned/stale (reaper job). */
  findStaleGenerations(
    criteria: {
      readonly generatingHeartbeatOlderThanSeconds: number;
      readonly pendingOlderThanSeconds: number;
      readonly limit?: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly StaleGenerationRow[]>;

  /**
   * Claim an idempotency key inside T1 (S4 recipe). Returns `{ claimed: true }` when this caller
   * is the first to use the key, or the previously stored response when the key exists.
   *
   * Uses `ON CONFLICT ... DO UPDATE ... RETURNING` rather than `DO NOTHING` so a concurrent
   * uncommitted insert is *waited on*: the loser re-reads the winner's committed row instead of
   * racing past an invisible one (AGENTS §6.12 T4 correction, decision S4).
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

  /** Count this user's live generations (for user concurrency quotas). */
  countActiveForUser(userId: string, tx?: TransactionContext): Promise<number>;

  /** Count all active generations on this node/cluster — the `MAX_ACTIVE_GENERATIONS` admission check. */
  countActiveNodeWide(tx?: TransactionContext): Promise<number>;
}

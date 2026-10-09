import type { NormalizedChatRequest } from '../domain/capabilities.ts';
import type { ProviderError } from '../domain/errors.ts';
import type { GenerationEvent } from '../domain/pal.ts';

export interface EstimateResult {
  readonly tokens: number;
  readonly confidence: 'exact' | 'approx';
}

export interface ExecuteContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
}

/**
 * The adapter contract every provider implements. Owned by the consumers
 * (`generations/`, `orchestrator/`) and implemented under `providers/adapters/<name>/`.
 *
 * Rules:
 * - config and secrets arrive by injection; adapters never read env or the DB;
 * - `execute` MUST honor `signal` and MUST emit exactly one terminal event;
 * - adapters never persist anything and never touch storage.
 */
export interface ProviderAdapter {
  readonly adapterKey: string;

  /** Pure transform used by tests and token estimation. No network. */
  toProviderRequest(req: NormalizedChatRequest): unknown;

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult>;

  execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent>;

  translateError(err: unknown): ProviderError;

  healthCheck(ctx: { signal: AbortSignal }): Promise<HealthCheckResult>;
}

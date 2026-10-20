/** Persistence for `quota_policies`; resolution logic lives in `../domain/policy.ts`. */
import type { TransactionContext } from '@/db/tx.ts';
import type { QuotaPolicyRow } from '../domain/policy.ts';

export type PolicyScope = 'global' | 'division' | 'user';

export interface UpsertPolicyInput {
  readonly id: string;
  readonly scope: PolicyScope;
  readonly divisionId: string | null;
  readonly userId: string | null;
  readonly monthlyTokens: number | null;
  readonly maxInputTokensPerRequest: number | null;
  readonly maxOutputTokensPerRequest: number | null;
  readonly maxConcurrentGenerations: number | null;
  readonly allowedModelIds: readonly string[] | null;
  readonly updatedBy: string | null;
}

export interface QuotaPolicyRepository {
  findPolicy(
    scope: PolicyScope,
    targetId: string | null,
    tx?: TransactionContext,
  ): Promise<QuotaPolicyRow | null>;

  upsertPolicy(input: UpsertPolicyInput, tx: TransactionContext): Promise<QuotaPolicyRow>;
}

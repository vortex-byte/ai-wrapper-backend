import { and, eq, isNull } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { quotaPolicies } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { QuotaPolicyRow } from '../domain/policy.ts';import type {
  PolicyScope,
  QuotaPolicyRepository,
  UpsertPolicyInput,
} from '../ports/quota-policy-repository.ts';

/** Drizzle implementation over `quota_policies` (unique on (scope, coalesced target)). */
export class DrizzleQuotaPolicyRepository implements QuotaPolicyRepository {
  async findPolicy(
    scope: PolicyScope,
    targetId: string | null,
    tx?: TransactionContext,
  ): Promise<QuotaPolicyRow | null> {
    if (scope !== 'global' && (!targetId || targetId.trim() === '')) {
      return null;
    }

    const id = targetId ?? '';
    const predicate =
      scope === 'global'
        ? and(
            eq(quotaPolicies.scope, 'global'),
            isNull(quotaPolicies.divisionId),
            isNull(quotaPolicies.userId),
          )
        : scope === 'division'
          ? and(eq(quotaPolicies.scope, 'division'), eq(quotaPolicies.divisionId, id))
          : and(eq(quotaPolicies.scope, 'user'), eq(quotaPolicies.userId, id));

    const rows = await runDb(tx)
      .select({
        id: quotaPolicies.id,
        scope: quotaPolicies.scope,
        divisionId: quotaPolicies.divisionId,
        userId: quotaPolicies.userId,
        monthlyTokens: quotaPolicies.monthlyTokens,
        maxInputTokensPerRequest: quotaPolicies.maxInputTokensPerRequest,
        maxOutputTokensPerRequest: quotaPolicies.maxOutputTokensPerRequest,
        maxConcurrentGenerations: quotaPolicies.maxConcurrentGenerations,
        allowedModelIds: quotaPolicies.allowedModelIds,
      })
      .from(quotaPolicies)
      .where(predicate)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      scope: row.scope as QuotaPolicyRow['scope'],
      divisionId: row.divisionId,
      userId: row.userId,
      monthlyTokens: row.monthlyTokens,
      maxInputTokensPerRequest: row.maxInputTokensPerRequest,
      maxOutputTokensPerRequest: row.maxOutputTokensPerRequest,
      maxConcurrentGenerations: row.maxConcurrentGenerations,
      allowedModelIds: row.allowedModelIds,
    };
  }

  async upsertPolicy(input: UpsertPolicyInput, tx: TransactionContext): Promise<QuotaPolicyRow> {
    const result = await tx.client.query<PolicyRowShape>(
      `
      INSERT INTO quota_policies
        (id, scope, division_id, user_id, monthly_tokens, max_input_tokens_per_request,
         max_output_tokens_per_request, max_concurrent_generations, allowed_model_ids, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (scope, COALESCE(division_id, user_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET
        monthly_tokens = EXCLUDED.monthly_tokens,
        max_input_tokens_per_request = EXCLUDED.max_input_tokens_per_request,
        max_output_tokens_per_request = EXCLUDED.max_output_tokens_per_request,
        max_concurrent_generations = EXCLUDED.max_concurrent_generations,
        allowed_model_ids = EXCLUDED.allowed_model_ids,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING scope, division_id AS "divisionId", user_id AS "userId",
                monthly_tokens AS "monthlyTokens",
                max_input_tokens_per_request AS "maxInputTokensPerRequest",
                max_output_tokens_per_request AS "maxOutputTokensPerRequest",
                max_concurrent_generations AS "maxConcurrentGenerations",
                allowed_model_ids AS "allowedModelIds"
      `,
      [
        input.id,
        input.scope,
        input.divisionId,
        input.userId,
        input.monthlyTokens,
        input.maxInputTokensPerRequest,
        input.maxOutputTokensPerRequest,
        input.maxConcurrentGenerations,
        input.allowedModelIds === null ? null : input.allowedModelIds,
        input.updatedBy,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('quota_policies upsert returned no row');
    return toPolicyRow(row);
  }
}

interface PolicyRowShape {
  scope: string;
  divisionId: string | null;
  userId: string | null;
  monthlyTokens: string | number | null;
  maxInputTokensPerRequest: number | null;
  maxOutputTokensPerRequest: number | null;
  maxConcurrentGenerations: number | null;
  allowedModelIds: string[] | null;
  updatedBy: string | null;
  updatedAt: Date;
}

function toPolicyRow(row: PolicyRowShape): QuotaPolicyRow {
  return {
    scope: row.scope as QuotaPolicyRow['scope'],
    divisionId: row.divisionId,
    userId: row.userId,
    monthlyTokens:
      row.monthlyTokens === null ? null : typeof row.monthlyTokens === 'number' ? row.monthlyTokens : Number.parseInt(row.monthlyTokens, 10),
    maxInputTokensPerRequest: row.maxInputTokensPerRequest,
    maxOutputTokensPerRequest: row.maxOutputTokensPerRequest,
    maxConcurrentGenerations: row.maxConcurrentGenerations,
    allowedModelIds: row.allowedModelIds,
  };
}

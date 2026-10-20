import { getLogger } from '@/observability/logger.ts';
import { withTransaction } from '@/db/tx.ts';
import type { UsageRepository } from '@/quota/ports/usage-repository.ts';

export function createUsageRollupHandler(deps: { readonly usage: UsageRepository }): {
  readonly incremental: () => Promise<{ day: string; rows: number }>;
  readonly nightly: () => Promise<{ day: string; rows: number }>;
} {
  const rollup = async (day: string): Promise<number> => {
    return withTransaction(async (tx) => deps.usage.rollupDay(day, tx));
  };

  return {
    /** Recompute today (UTC date) — scheduled every 5 minutes. */
    incremental: async (): Promise<{ day: string; rows: number }> => {
      const day = new Date().toISOString().slice(0, 10);
      const rows = await rollup(day);
      return { day, rows };
    },
    /** Recompute yesterday (UTC date) — scheduled nightly. */
    nightly: async (): Promise<{ day: string; rows: number }> => {
      const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
      const rows = await rollup(day);
      getLogger().info({ day, rows }, 'usage_daily nightly rebuild finished');
      return { day, rows };
    },
  };
}

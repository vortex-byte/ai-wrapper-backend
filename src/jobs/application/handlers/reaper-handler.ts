import type { GenerationRepository } from '@/generations/ports/generation-repository.ts';
import type { Finalizer } from '@/generations/application/finalizer.ts';
import { getLogger } from '@/observability/logger.ts';

export interface ReaperHandlerDeps {
  readonly generations: GenerationRepository;
  readonly finalizer: Finalizer;
}

export function createReaperHandler(deps: ReaperHandlerDeps) {
  return async (): Promise<{ reapedCount: number }> => {
    const rows = await deps.generations.findStaleGenerations({
      generatingHeartbeatOlderThanSeconds: 45,
      pendingOlderThanSeconds: 30,
      limit: 100,
    });

    if (rows.length === 0) {
      return { reapedCount: 0 };
    }

    let reapedCount = 0;
    for (const row of rows) {
      try {
        const finalized = await deps.finalizer.finalize({
          generationId: row.id,
          status: 'failed',
          finishReason: 'interrupted',
          accumulatedText: '',
          error: {
            code: 'generation_interrupted',
            message: 'Generation was abandoned or worker process crashed.',
            retryable: false,
          },
        });

        if (finalized) {
          reapedCount++;
          getLogger().info(
            { generationId: row.id, previousStatus: row.status },
            'reaper finalized abandoned generation',
          );
        }
      } catch (err) {
        getLogger().error(
          { err, generationId: row.id },
          'reaper failed to finalize abandoned generation',
        );
      }
    }

    return { reapedCount };
  };
}

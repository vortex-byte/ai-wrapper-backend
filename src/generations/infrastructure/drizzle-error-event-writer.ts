import { runDb } from '@/db/client.ts';
import { errorEvents } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { getLogger } from '@/observability/logger.ts';
import type { ErrorEventEntry, ErrorEventWriter } from '../ports/error-event-writer.ts';

/**
 * Writes `error_events` rows. Telemetry is best-effort: a failure to record an error must never
 * mask or replace the original failure, so this swallows and logs its own errors.
 */
export class DrizzleErrorEventWriter implements ErrorEventWriter {
  async record(entry: ErrorEventEntry, tx?: TransactionContext): Promise<void> {
    try {
      await runDb(tx)
        .insert(errorEvents)
        .values({
          requestId: entry.requestId ?? null,
          component: entry.component,
          category: entry.category,
          providerId: entry.providerId ?? null,
          modelId: entry.modelId ?? null,
          generationId: entry.generationId ?? null,
          message: entry.message,
          context: entry.context ?? {},
        });
    } catch (error) {
      getLogger().error(
        { err: error, component: entry.component, category: entry.category },
        'failed to record error event',
      );
    }
  }
}

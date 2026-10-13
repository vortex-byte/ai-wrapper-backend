import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok, okEmpty } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import type { AppEnv } from '@/http/types.ts';
import type { GenerationRepository } from '../ports/generation-repository.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { GenerationManager } from '@/orchestrator/generation-manager.ts';
import type { GenerationMetrics } from '@/observability/metrics.ts';
import type { Finalizer } from '../application/finalizer.ts';

export interface GenerationRoutesDeps {
  readonly generations: GenerationRepository;
  readonly conversations: ConversationRepository;
  readonly orchestrator: GenerationManager;
  readonly finalizer: Finalizer;
  readonly auth: AuthService;
  readonly config: Config;
  readonly metrics?: GenerationMetrics | undefined;
}

/**
 * Generation status, cancel, and SSE stream API.
 * PRD §7.1, §7.2, §7.3 & API_CONTRACTS §7.
 */
export function generationRoutes(deps: GenerationRoutesDeps): Hono<AppEnv> {
  const { generations, conversations, orchestrator, finalizer, auth, config, metrics } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('/generations/*', requireAuth(auth, config));
  routes.use('/generations/*', requirePasswordChanged());
  routes.use('/generations/*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return requireCsrf(config)(c, next);
  });

  routes.get('/generations/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');

    const id = c.req.param('id');
    const record = await generations.findByIdForUser(id, caller.user.id);
    if (record === null) {
      throw new AppError('not_found', 'Generation not found.');
    }

    return c.json(
      ok({
        id: record.id,
        conversationId: record.conversationId,
        status: record.status,
        finishReason: record.cancelReason ?? (record.status === 'completed' ? 'stop' : null),
        usage: null,
        remainingQuota: null,
        error:
          record.status === 'failed' && record.errorCategory !== null
            ? {
                code: record.errorCategory,
                message:
                  typeof record.errorDetail === 'object' && record.errorDetail !== null
                    ? String((record.errorDetail as Record<string, unknown>)['message'] ?? '')
                    : '',
                retryable:
                  typeof record.errorDetail === 'object' && record.errorDetail !== null
                    ? Boolean((record.errorDetail as Record<string, unknown>)['retryable'])
                    : false,
              }
            : null,
      }),
    );
  });

  routes.post('/generations/:id/cancel', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');

    const id = c.req.param('id');
    const record = await generations.findByIdForUser(id, caller.user.id);
    if (record === null) {
      throw new AppError('not_found', 'Generation not found.');
    }

    // Attempt in-memory cancellation if a local run exists. When it does, the run's own lifecycle
    // finalizes the generation with the full accumulated text and captured provider usage — the
    // route must NOT finalize concurrently, or it would win the T3 race and persist an incomplete
    // text and estimated usage instead of the real ones.
    const cancelledLiveRun = orchestrator.cancel(id, 'user_cancel');

    if (!cancelledLiveRun && (record.status === 'pending' || record.status === 'generating')) {
      // Orphaned generation (no in-memory run, e.g. another node crashed or this node restarted):
      // finalize it here so the conversation is not blocked until the reaper sweeps it.
      await finalizer.finalize({
        generationId: id,
        status: 'cancelled',
        finishReason: 'user_cancel',
        accumulatedText: '',
      });
    }

    return c.json(okEmpty('Cancellation requested.'), 202);
  });

  routes.get('/generations/:id/stream', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');

    const id = c.req.param('id');
    const record = await generations.findByIdForUser(id, caller.user.id);
    if (record === null) {
      throw new AppError('not_found', 'Generation not found.');
    }

    const lastEventIdHeader = c.req.header('last-event-id');
    let lastEventSeq: number | undefined;
    if (lastEventIdHeader !== undefined) {
      const parsed = parseInt(lastEventIdHeader, 10);
      if (!Number.isNaN(parsed)) {
        lastEventSeq = parsed;
        metrics?.sseReconnects.inc();
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    metrics?.sseConnectionsActive.inc();

    return streamSSE(c, async (stream) => {
      let isClosed = false;
      const cleanup = () => {
        if (!isClosed) {
          isClosed = true;
          metrics?.sseConnectionsActive.dec();
        }
      };

      stream.onAbort(() => {
        cleanup();
      });

      const subResult = orchestrator.subscribe(id, lastEventSeq);

      if (subResult.found && subResult.canReplay && subResult.subscriber !== undefined) {
        const subscriber = subResult.subscriber;
        stream.onAbort(() => {
          subscriber.close();
          cleanup();
        });

        try {
          for await (const frame of subscriber) {
            if (isClosed) break;
            if (frame.comment === true) {
              // Bare SSE comment keep-alive: never carries an id/event/data (PRD §14.3).
              await stream.write(':heartbeat\n\n');
              continue;
            }
            await stream.writeSSE({
              id: String(frame.id),
              event: frame.event,
              data: frame.data,
            });
            if (
              frame.event === 'generation.completed' ||
              frame.event === 'generation.cancelled' ||
              frame.event === 'generation.failed'
            ) {
              break;
            }
          }
        } finally {
          subscriber.close();
          cleanup();
        }
        return;
      }

      // Buffer miss or run already finished: emit snapshot from DB.
      try {
        let lastEmittedText: string = '';
        let lastEmittedStatus: string | null = null;

        const writeSnapshot = async (): Promise<void> => {
          const messageWithParts = await conversations.findMessageForUser(
            record.assistantMessageId,
            caller.user.id,
          );
          if (messageWithParts === null) return;
          const currentText = messageWithParts.parts.map((p) => p.textContent ?? '').join('');
          if (currentText === lastEmittedText && messageWithParts.message.status === lastEmittedStatus) {
            return;
          }
          lastEmittedText = currentText;
          lastEmittedStatus = messageWithParts.message.status;

          await stream.writeSSE({
            event: 'snapshot',
            data: JSON.stringify({
              message: {
                id: messageWithParts.message.id,
                seq: messageWithParts.message.seq,
                role: messageWithParts.message.role,
                status: messageWithParts.message.status,
                finishReason: messageWithParts.message.finishReason,
                parts: messageWithParts.parts.map((p) => ({
                  id: p.id,
                  position: p.position,
                  type: p.type,
                  text: p.textContent ?? '',
                })),
              },
            }),
          });
        };

        await writeSnapshot();

        let currentRecord = await generations.findById(id);
        if (currentRecord === null) {
          cleanup();
          return;
        }

        while (!isClosed && (currentRecord.status === 'pending' || currentRecord.status === 'generating')) {
          // Poll every 2 s per D4, emitting a comment heartbeat each tick so intermediaries do not
          // time the idle connection out, and a fresh snapshot once new text has landed.
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (isClosed) break;
          await stream.write(':heartbeat\n\n');
          await writeSnapshot();
          const refreshed = await generations.findById(id);
          if (refreshed === null) break;
          currentRecord = refreshed;
        }

        if (!isClosed) {
          // Final snapshot before the terminal frame, so a late subscriber that fell off the
          // in-memory buffer still receives the completed text rather than only "completed".
          await writeSnapshot();

          if (currentRecord.status === 'completed') {
            const assistantMsg = await conversations.findMessageForUser(
              currentRecord.assistantMessageId,
              caller.user.id,
            );
            const finishReason = assistantMsg?.message.finishReason ?? 'stop';
            await stream.writeSSE({
              event: 'generation.completed',
              data: JSON.stringify({
                finishReason,
                usage: {
                  input: currentRecord.estInputTokens ?? 0,
                  output: Math.ceil((lastEmittedText?.length ?? 0) / 4),
                  quotaTokens: 0,
                },
                remainingQuota: null,
              }),
            });
          } else if (currentRecord.status === 'cancelled') {
            await stream.writeSSE({
              event: 'generation.cancelled',
              data: JSON.stringify({
                reason: currentRecord.cancelReason ?? 'user_cancel',
              }),
            });
          } else if (currentRecord.status === 'failed') {
            await stream.writeSSE({
              event: 'generation.failed',
              data: JSON.stringify({
                error: {
                  code: currentRecord.errorCategory ?? 'internal_error',
                  message: 'Generation failed',
                  retryable: false,
                },
              }),
            });
          }
        }
      } finally {
        cleanup();
      }
    });
  });

  return routes;
}

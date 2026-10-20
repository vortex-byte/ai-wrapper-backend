import { Hono } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { decodeTimestampCursor } from '@/cursor.ts';
import { ok, okEmpty } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import { rateLimit, userRateLimit } from '@/http/middleware/rate-limit.ts';
import type { RateLimiter } from '@/http/ports/rate-limiter.ts';
import type { Conversation, MessagePart, MessageWithParts } from '../domain/conversation.ts';
import type { ConversationService } from '../application/conversation-service.ts';
import type { SendService } from '@/generations/application/send-service.ts';
import {
  CreateConversationBodySchema,
  IdempotencyKeySchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  RenameConversationBodySchema,
  RetryMessageBodySchema,
  SendMessageBodySchema,
} from './schemas.ts';

export interface ConversationRoutesDeps {
  readonly conversations: ConversationService;
  readonly send: SendService;
  readonly auth: AuthService;
  readonly config: Config;
  readonly rateLimiter: RateLimiter;
}

/**
 * Every route is scoped to the signed-in user; another user's id yields `404 not_found`.
 */
export function conversationRoutes(deps: ConversationRoutesDeps): Hono<AppEnv> {
  const { conversations, send, auth, config, rateLimiter } = deps;
  const routes = new Hono<AppEnv>();

  const generationLimit = rateLimit(config, rateLimiter, {
    name: 'generation',
    scope: 'user',
    limit: config.RATE_LIMIT_GENERATION_REQUESTS,
    windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
    message: 'Too many generation requests. Try again shortly.',
  });

  routes.use('/conversations/*', requireAuth(auth, config));
  routes.use('/conversations/*', requirePasswordChanged());
  routes.use('/conversations/*', userRateLimit(config, rateLimiter));
  routes.use('/conversations/*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return requireCsrf(config)(c, next);
  });

  routes.get('/conversations', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsed = ListConversationsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('invalid_request', 'Invalid query parameters.');
    const cursor = parsed.data.cursor ? decodeTimestampCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor !== undefined && cursor === null) {
      throw new AppError('invalid_request', 'The cursor is invalid or expired.');
    }
    const page = await conversations.list({
      userId: caller.user.id,
      limit: parsed.data.limit,
      cursor,
    });
    return c.json(ok({ items: page.items.map(toWireConversation), nextCursor: page.nextCursor }));
  });

  routes.post('/conversations', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, CreateConversationBodySchema);
    const conversation = await conversations.create({
      userId: caller.user.id,
      modelId: body.modelId,
      title: body.title ?? null,
    });
    return c.json(ok(toWireConversationDetail(conversation), 'Conversation created.'), 201);
  });

  routes.get('/conversations/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const conversation = await conversations.get(c.req.param('id'), caller.user.id);
    return c.json(ok(toWireConversationDetail(conversation)));
  });

  routes.patch('/conversations/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, RenameConversationBodySchema);
    const conversation = await conversations.rename(c.req.param('id'), caller.user.id, body.title);
    return c.json(ok(toWireConversationDetail(conversation), 'Conversation updated.'));
  });

  routes.delete('/conversations/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    await conversations.remove(c.req.param('id'), caller.user.id);
    return c.json(okEmpty('Conversation deleted.'));
  });

  routes.get('/conversations/:id/messages', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const parsed = ListMessagesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('invalid_request', 'Invalid query parameters.');
    const page = await conversations.listMessages({
      conversationId: c.req.param('id'),
      userId: caller.user.id,
      limit: parsed.data.limit,
      before: parsed.data.before ?? null,
    });
    return c.json(
      ok({
        items: page.items.map(toWireMessage),
        nextCursor: page.nextCursor,
      }),
    );
  });

  routes.post('/conversations/:id/messages', generationLimit, async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');

    const idempotencyKey = readIdempotencyKey(c.req.header('idempotency-key'));
    const body = await parseJsonBody(c, SendMessageBodySchema);

    const result = await send.send({
      userId: caller.user.id,
      conversationId: c.req.param('id'),
      idempotencyKey,
      requestId: c.get('requestId'),
      parts: body.parts,
      options: body.options,
    });

    if (result.replayed) {
      c.header('Idempotency-Replayed', 'true');
    }
    return c.json(ok(result.payload, 'Generation queued.'), 202);
  });

  routes.post('/conversations/:id/messages/:mid/retry', generationLimit, async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');

    const idempotencyKey = readIdempotencyKey(c.req.header('idempotency-key'));
    const body = await parseJsonBody(c, RetryMessageBodySchema);

    const result = await send.retry({
      userId: caller.user.id,
      conversationId: c.req.param('id'),
      userMessageId: c.req.param('mid'),
      idempotencyKey,
      requestId: c.get('requestId'),
      options: body.options,
    });

    if (result.replayed) {
      c.header('Idempotency-Replayed', 'true');
    }
    return c.json(ok(result.payload, 'Generation retried.'), 202);
  });

  return routes;
}

function toWireConversation(conversation: Conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    modelId: conversation.modelId,
    messageCount: conversation.messageCount,
    lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
    createdAt: conversation.createdAt.toISOString(),
  };
}

function toWireConversationDetail(conversation: Conversation) {
  return {
    ...toWireConversation(conversation),
    updatedAt: conversation.updatedAt.toISOString(),
    modelLocked: conversation.messageCount > 0,
  };
}

function toWireMessage(item: MessageWithParts) {
  const { message, parts } = item;
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    finishReason: message.finishReason,
    createdAt: message.createdAt.toISOString(),
    generationId: (message.metadata['generationId'] as string | undefined) ?? null,
    parts: parts.map(toWirePart),
  };
}

function toWirePart(part: MessagePart) {
  const base = { id: part.id, position: part.position, type: part.type };
  if (part.type === 'text') {
    return {
      ...base,
      format: (part.data['format'] as string | undefined) ?? 'markdown',
      text: part.textContent ?? '',
    };
  }
  if (part.type === 'image' || part.type === 'document' || part.type === 'generated_file') {
    return {
      ...base,
      origin: (part.data['origin'] as string | undefined) ?? 'user',
      file: null,
    };
  }
  return { ...base, data: part.data };
}

function readIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === '') {
    throw new AppError('invalid_request', 'The Idempotency-Key header is required.', {
      details: { fields: [{ field: 'Idempotency-Key', message: 'Required.' }] },
    });
  }
  const parsed = IdempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError('invalid_request', 'The Idempotency-Key header must be a UUID.', {
      details: { fields: [{ field: 'Idempotency-Key', message: 'Must be a UUID.' }] },
    });
  }
  return parsed.data;
}

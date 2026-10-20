import { z } from 'zod';
import { decodeSeqCursor } from '@/cursor.ts';

/**
 * Zod schemas for the conversation endpoints. Query strings arrive as
 * text; `limit` is coerced and bounded, `cursor` is validated as a well-formed opaque token
 * so a corrupt one becomes `400 invalid_request` instead of a silent first page.
 */

const CursorSchema = z
  .string()
  .refine((value) => {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const separator = decoded.indexOf('|');
      if (separator <= 0 || separator === decoded.length - 1) return false;
      const [key, id] = [decoded.slice(0, separator), decoded.slice(separator + 1)];
      return key.length > 0 && id.length > 0;
    } catch {
      return false;
    }
  }, 'The cursor is invalid or expired.')
  .optional();

export const ListConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema,
});

export const CreateConversationBodySchema = z.object({
  modelId: z.uuid(),
  title: z.string().trim().max(200).nullable().optional(),
});

export const RenameConversationBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});

const MessageBeforeSchema = z
  .union([z.string(), z.number()])
  .transform((val, ctx) => {
    if (typeof val === 'number') {
      if (Number.isSafeInteger(val) && val > 0) {
        return { seq: val };
      }
    } else if (typeof val === 'string') {
      if (/^\d+$/.test(val)) {
        const seq = Number(val);
        if (Number.isSafeInteger(seq) && seq > 0) {
          return { seq };
        }
      }
      const decoded = decodeSeqCursor(val);
      if (decoded !== null) {
        return { seq: decoded.seq };
      }
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The before parameter is invalid.',
    });
    return z.NEVER;
  })
  .optional();

export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: MessageBeforeSchema,
});

const SendPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('file'), fileId: z.uuid() }),
]);

const SendOptionsSchema = z
  .object({
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    tools: z.object({ imageGeneration: z.boolean().optional() }).optional(),
  })
  .optional();

export const SendMessageBodySchema = z.object({
  parts: z.array(SendPartSchema).min(1).max(50),
  options: SendOptionsSchema,
});

export const RetryMessageBodySchema = z.object({
  options: SendOptionsSchema,
});

export const IdempotencyKeySchema = z.uuid();

export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;
export type RenameConversationBody = z.infer<typeof RenameConversationBodySchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type RetryMessageBody = z.infer<typeof RetryMessageBodySchema>;

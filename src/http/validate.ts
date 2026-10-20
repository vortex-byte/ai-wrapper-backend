import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../errors.ts';
import type { AppEnv } from './types.ts';

/** Reject JSON bodies above this size before parsing (bytes). */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Parses and validates a JSON body at the boundary; failures become `400 invalid_request` with
 * field-level `details`. The size is bounded first, so an oversized body is rejected with `413`
 * instead of being buffered.
 */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  const declaredLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new AppError('file_too_large', 'The request body is too large.');
  }

  const raw = await readJson(c);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('invalid_request', 'The request is invalid.', {
      details: {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) {
    throw new AppError('file_too_large', 'The request body is too large.');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }
}

import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../errors.ts';
import type { AppEnv } from './types.ts';

/** Reject JSON bodies above this size before parsing (bytes). */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Parses and validates JSON request body against a Zod schema with size checks. */
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
  const req = c.req.raw;
  if (!req.body) {
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_JSON_BODY_BYTES) {
          await reader.cancel();
          throw new AppError('file_too_large', 'The request body is too large.');
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder('utf-8').decode(merged);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }
}

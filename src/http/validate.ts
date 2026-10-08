import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../errors.ts';
import type { AppEnv } from './types.ts';

/**
 * Parse and validate a JSON request body at the boundary (AGENTS §3.3: no business
 * logic in routes). A malformed body or a schema failure becomes `400 invalid_request`
 * with field-level `details`, matching the error catalog (API_CONTRACTS §14).
 */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('invalid_request', 'A JSON body is required.', {
      details: { fields: [{ path: '(body)', message: 'Expected a valid JSON object.' }] },
    });
  }

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

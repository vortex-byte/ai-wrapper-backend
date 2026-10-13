import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Config } from '../config/index.ts';
import { getLogger } from '../observability/logger.ts';
import { errorEnvelope, envelopeFromError } from './envelope.ts';
import { AppError, isAppError } from '../errors.ts';
import type { AppEnv } from './types.ts';

/**
 * The single place errors become responses. `trace` is emitted
 * only when `NODE_ENV=development`; anything that is not an `AppError` is logged and
 * reported as a generic `internal_error` so internals never leak.
 */
export function onError(config: Config) {
  return (error: Error, c: Context<AppEnv>): Response => {
    const includeTrace = config.NODE_ENV === 'development';
    const logger = c.get('logger') ?? getLogger();
    const requestId = c.get('requestId');

    if (isAppError(error)) {
      if (error.status >= 500) {
        logger.error({ err: error, requestId }, 'request failed');
      } else {
        logger.warn({ code: error.code, status: error.status, requestId }, 'request rejected');
      }
      if (error.details !== null && typeof error.details === 'object') {
        const detailsObj = error.details as Record<string, unknown>;
        if (typeof detailsObj['retryAfterSeconds'] === 'number') {
          c.header('Retry-After', String(detailsObj['retryAfterSeconds']));
        } else if (typeof detailsObj['retryAfterMs'] === 'number') {
          c.header('Retry-After', String(Math.max(1, Math.ceil(detailsObj['retryAfterMs'] / 1000))));
        }
      }
      const trace = includeTrace ? error.stack : undefined;
      return c.json(
        envelopeFromError(error, { includeTrace, trace }),
        error.status as ContentfulStatusCode,
      );
    }

    logger.error({ err: error, requestId }, 'unhandled error');
    const internal = new AppError('internal_error', undefined, { cause: error });
    const trace = includeTrace ? error.stack : undefined;
    return c.json(envelopeFromError(internal, { includeTrace, trace }), 500);
  };
}

/** Uniform 404 for anything unmatched, including unknown `/api` routes. */
export function notFound(c: Context<AppEnv>): Response {
  return c.json(
    errorEnvelope({ code: 'not_found', message: 'Not found.', retryable: false }),
    404,
  );
}

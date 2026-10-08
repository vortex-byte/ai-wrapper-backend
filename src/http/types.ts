import type { Logger } from '../observability/logger.ts';

/**
 * Hono environment for this app. `Variables` are per-request values set by
 * middleware. Keep this list small and explicit.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
  };
}

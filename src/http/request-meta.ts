import type { Context } from 'hono';
import { hashUserAgent } from '../crypto.ts';
import type { RequestMeta } from '../request-context.ts';
import type { AppEnv } from '../http/types.ts';

/**
 * Build the audit provenance for the current request. The client IP honors
 * `TRUST_PROXY` through Hono's `getConnInfo`-free path: we read the forwarding header
 * only when the deployment says it sits behind a proxy; otherwise the socket address
 * is unavailable to a Hono `fetch` handler, so we fall back to the header value only
 * when explicitly trusted.
 *
 * Never includes the raw user-agent or any content (PRD §15.10).
 */
export function requestMeta(c: Context<AppEnv>, clientIp: string | null): RequestMeta {
  return {
    ip: clientIp,
    userAgentHash: hashUserAgent(c.req.header('user-agent')),
    requestId: c.get('requestId') ?? null,
  };
}

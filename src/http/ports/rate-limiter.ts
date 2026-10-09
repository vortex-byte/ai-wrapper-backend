/**
 * Consumer port for rate limiting.
 * Kept generic so it can be backed by in-memory token buckets (single-node)
 * or Redis (multi-node).
 */

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult>;
}

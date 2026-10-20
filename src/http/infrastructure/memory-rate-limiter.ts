import type { RateLimitCheckResult, RateLimiter } from '../ports/rate-limiter.ts';

interface Bucket {
  count: number;
  resetAtMs: number;
}

export interface MemoryRateLimiterOptions {
  /** Hard cap on tracked keys; oldest-expiring buckets are evicted first. */
  readonly maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * In-memory fixed-window rate limiter (single-process default).
 *
 * Bounded by design: an attacker rotating keys (e.g. spoofed forwarded IPs) cannot grow
 * the map without limit. Expired buckets are swept on a periodic tick, and if the map is
 * still at capacity the entries closest to expiry are evicted first. The map is safe for
 * Node/Bun's single-threaded event loop.
 *
 * This limiter is **per process**. With more than one instance the port must be backed by
 * a shared store (Redis) so the effective limit does not multiply by replica count; the
 * `RateLimiter` port exists precisely so that swap stays a composition-root change.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(
    private readonly clock: { now: () => Date } = { now: () => new Date() },
    options: MemoryRateLimiterOptions = {},
  ) {
    this.maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult> {
    const nowMs = this.clock.now().getTime();
    const windowMs = windowSeconds * 1000;

    this.sweepExpired(nowMs);

    let bucket = this.buckets.get(key);

    if (!bucket || nowMs >= bucket.resetAtMs) {
      if (!bucket && this.buckets.size >= this.maxKeys) {
        this.evictSoonest();
      }
      bucket = {
        count: 0,
        resetAtMs: nowMs + windowMs,
      };
      this.buckets.set(key, bucket);
    }

    const resetAt = new Date(bucket.resetAtMs);

    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
      };
    }

    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);

    return {
      allowed: true,
      limit,
      remaining,
      resetAt,
    };
  }

  private sweepExpired(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAtMs) this.buckets.delete(key);
    }
  }

  private evictSoonest(): void {
    let soonestKey: string | undefined;
    let soonestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs < soonestAt) {
        soonestAt = bucket.resetAtMs;
        soonestKey = key;
      }
    }
    if (soonestKey !== undefined) this.buckets.delete(soonestKey);
  }

  /** Number of tracked keys — used by tests to assert the bound holds. */
  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

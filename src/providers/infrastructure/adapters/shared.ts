import type { ProviderError } from '../../domain/errors.ts';
import { providerError } from '../../domain/errors.ts';
import type { EstimateResult, HealthCheckResult } from '../../ports/provider-adapter.ts';

/**
 * Shared helpers for real provider adapters. Kept SDK-agnostic so each adapter owns its
 * own client types; nothing here imports a provider SDK (only the adapter does, which is
 * the one directory allowed to).
 */

/** The PAL `config` blob for adapters is open; each adapter validates what it reads. */
export function numberFromConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function stringFromConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** A health check that failed before any network call (e.g. no key configured). */
export function healthNotConfigured(detail: string): HealthCheckResult {
  return { ok: false, latencyMs: 0, detail };
}

/** Map an unexpected adapter exception to a sanitized health result (never the raw body). */
export function healthFailed(error: unknown, latencyMs = 0): HealthCheckResult {
  const detail = error instanceof Error ? error.message || error.name : 'unknown_error';
  return { ok: false, latencyMs, detail };
}

/** Creates a standard provider error for unimplemented operations. */
export function notImplementedError(provider: string): ProviderError {
  return providerError('provider_unavailable', 'The model provider is unavailable.', {
    retryable: true,
    internalMessage: `${provider} adapter execute() is not implemented`,
  });
}

export function approximateEstimate(textLength: number): EstimateResult {
  return { tokens: Math.ceil(textLength / 4) + 8, confidence: 'approx' };
}

export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Transport-level cancellation detection shared by real adapters. Provider SDKs
 * surface aborts as classes that never set `err.name` (they inherit "Error"),
 * so match on the SDK class plus message content.
 */
export function isAbortLikeError(
  err: unknown,
  abortClasses: ReadonlyArray<new (...args: never[]) => Error> = [],
): boolean {
  for (const cls of abortClasses) {
    if (err instanceof cls) return true;
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    return err.message.toLowerCase().includes('abort');
  }
  if (typeof err === 'object' && err !== null) {
    return (err as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

/**
 * Transport-level timeout detection shared by real adapters. Both SDKs throw
 * `APIConnectionTimeoutError` with the message "Request timed out." (no custom
 * `name`), so a plain `includes('timeout')` check misses it.
 */
export function isTimeoutLikeError(
  err: unknown,
  timeoutClasses: ReadonlyArray<new (...args: never[]) => Error> = [],
): boolean {
  for (const cls of timeoutClasses) {
    if (err instanceof cls) return true;
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return true;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('etimedout') ||
      msg.includes('esockettimedout')
    );
  }
  return false;
}

export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

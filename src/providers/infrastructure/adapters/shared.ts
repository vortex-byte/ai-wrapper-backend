import type { EstimateResult, HealthCheckResult } from '../../ports/provider-adapter.ts';

/** Helpers shared by provider adapters. */

export function numberFromConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Health check result when credentials are not configured. */
export function healthNotConfigured(detail: string): HealthCheckResult {
  return { ok: false, latencyMs: 0, detail };
}

/** Maps an adapter exception to a sanitized health result. */
export function healthFailed(error: unknown, latencyMs = 0): HealthCheckResult {
  const detail = error instanceof Error ? error.message || error.name : 'unknown_error';
  return { ok: false, latencyMs, detail };
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

/** Detects abort and cancellation errors across provider SDK exceptions. */
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

/** Detects connection and request timeout errors across provider SDK exceptions. */
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

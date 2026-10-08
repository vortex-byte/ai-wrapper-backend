/**
 * Pure session rules: the effective expiry is the earlier of the sliding idle window
 * and the hard absolute window (PRD §15.1). No I/O.
 */

export interface SessionPolicy {
  readonly idleMinutes: number;
  readonly absoluteMinutes: number;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedFrom: string | null;
}

/** `last_seen_at` writes are throttled to at most once per minute (PRD §15.1). */
export const TOUCH_THROTTLE_MS = 60_000;

export function computeExpiry(createdAt: Date, lastSeenAt: Date, policy: SessionPolicy): Date {
  const idle = lastSeenAt.getTime() + policy.idleMinutes * 60_000;
  const absolute = createdAt.getTime() + policy.absoluteMinutes * 60_000;
  return new Date(Math.min(idle, absolute));
}

export function isSessionExpired(session: Pick<SessionRecord, 'expiresAt' | 'revokedAt'>, now: Date): boolean {
  if (session.revokedAt !== null) return true;
  return session.expiresAt.getTime() <= now.getTime();
}

export function shouldTouch(session: Pick<SessionRecord, 'lastSeenAt'>, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= TOUCH_THROTTLE_MS;
}

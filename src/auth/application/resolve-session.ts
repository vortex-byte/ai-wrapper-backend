import { hashSessionToken } from '@/crypto.ts';
import { computeExpiry, isSessionExpired, shouldTouch, type SessionRecord } from '../domain/session.ts';
import { isActive, type User } from '../domain/user.ts';
import type { AuthDeps } from './deps.ts';

export interface ResolvedSession {
  readonly user: User;
  readonly session: SessionRecord;
}

export async function resolveSession(
  deps: AuthDeps,
  token: string,
): Promise<ResolvedSession | null> {
  const sessionId = hashSessionToken(token);
  const found = await deps.sessions.findWithUser(sessionId);
  if (found === null) return null;

  const now = deps.clock.now();
  if (isSessionExpired(found.session, now)) return null;

  if (!isActive(found.user)) {
    await deps.sessions.revoke(sessionId, now);
    return null;
  }

  if (shouldTouch(found.session, now)) {
    const expiresAt = computeExpiry(found.session.createdAt, now, deps.sessionPolicy);
    await deps.sessions.touch(sessionId, now, expiresAt);
    return { user: found.user, session: { ...found.session, lastSeenAt: now, expiresAt } };
  }

  return { user: found.user, session: found.session };
}

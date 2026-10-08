import { AUDIT_ACTIONS } from '../../audit/actions.ts';
import { generateSessionToken, hashSessionToken } from '../../crypto.ts';
import { AppError } from '../../errors.ts';
import type { RequestMeta } from '../../request-context.ts';
import { passwordProblemMessage, validatePassword } from '../domain/password-policy.ts';
import { computeExpiry } from '../domain/session.ts';
import { isActive } from '../domain/user.ts';
import type { AuthDeps } from './deps.ts';

export interface ChangePasswordInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly meta: RequestMeta;
}

export interface ChangePasswordSuccess {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/**
 * Verifies the current password, applies the policy, stores the new hash, clears the
 * `must_change_password` gate, revokes every *other* session, and rotates the caller's
 * session (PRD §15.1, API_CONTRACTS §2.4).
 */
export async function changePassword(
  deps: AuthDeps,
  input: ChangePasswordInput,
): Promise<ChangePasswordSuccess> {
  const now = deps.clock.now();
  const user = await deps.users.findById(input.userId);
  if (user === null || !isActive(user)) {
    throw new AppError('unauthenticated');
  }

  const currentOk = await deps.hasher.verify(input.currentPassword, user.passwordHash);
  if (!currentOk) {
    await deps.audit.append({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.passwordChangeFailed,
      targetType: 'user',
      targetId: user.id,
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      userAgentHash: input.meta.userAgentHash,
    });
    throw new AppError('unauthenticated', 'Current password is incorrect.');
  }

  const problem = validatePassword(input.newPassword, deps.passwordPolicy);
  if (problem !== null) {
    throw new AppError('invalid_request', passwordProblemMessage(problem, deps.passwordPolicy));
  }

  if (await deps.hasher.verify(input.newPassword, user.passwordHash)) {
    throw new AppError('invalid_request', 'The new password must differ from the current one.');
  }

  const passwordHash = await deps.hasher.hash(input.newPassword);
  await deps.users.setPassword({ id: user.id, passwordHash, mustChangePassword: false, at: now });

  // Revoke every other session (defence against a stolen cookie), keep the caller's.
  await deps.sessions.revokeAllForUser(user.id, now, { exceptId: input.sessionId });

  // Rotate the caller's own session id.
  const token = generateSessionToken();
  const sessionId = hashSessionToken(token);
  const expiresAt = computeExpiry(now, now, deps.sessionPolicy);
  await deps.sessions.revoke(input.sessionId, now);
  await deps.sessions.insert({
    id: sessionId,
    userId: user.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rotatedFrom: input.sessionId,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });

  await deps.audit.append({
    actorUserId: user.id,
    action: AUDIT_ACTIONS.passwordChange,
    targetType: 'user',
    targetId: user.id,
    requestId: input.meta.requestId,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });

  return { token, sessionId, expiresAt };
}

import { AUDIT_ACTIONS } from '../../audit/actions.ts';
import type { RequestMeta } from '../../request-context.ts';
import type { AuthDeps } from './deps.ts';

export interface LogoutInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly meta: RequestMeta;
}

/** Revokes the caller's session. Idempotent: revoking an already-revoked id is a no-op. */
export async function logout(deps: AuthDeps, input: LogoutInput): Promise<void> {
  const now = deps.clock.now();
  await deps.sessions.revoke(input.sessionId, now);
  await deps.audit.append({
    actorUserId: input.userId,
    action: AUDIT_ACTIONS.logout,
    targetType: 'session',
    targetId: input.sessionId,
    requestId: input.meta.requestId,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });
}

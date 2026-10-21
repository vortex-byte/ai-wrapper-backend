import { AUDIT_ACTIONS } from '@/audit/actions.ts';
import { generateSessionToken, hashSessionToken } from '@/crypto.ts';
import { AppError } from '@/errors.ts';
import type { RequestMeta } from '@/request-context.ts';
import { computeExpiry } from '../domain/session.ts';
import { authenticationBlock, nextFailureState, type User } from '../domain/user.ts';
import type { AuthDeps } from './deps.ts';

const GENERIC_CREDENTIALS_ERROR = 'Invalid email or password.';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly meta: RequestMeta;
}

export interface LoginSuccess {
  readonly user: User;
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

let dummyHash: string | undefined;

async function ensureDummyHash(deps: AuthDeps): Promise<string> {
  dummyHash ??= await deps.hasher.hash('timing-equalizer-not-a-real-credential');
  return dummyHash;
}

export async function login(deps: AuthDeps, input: LoginInput): Promise<LoginSuccess> {
  const now = deps.clock.now();
  const user = await deps.users.findByEmail(input.email);

  if (user === null) {
    await deps.hasher.verify(input.password, await ensureDummyHash(deps));
    throw new AppError('unauthenticated', GENERIC_CREDENTIALS_ERROR);
  }

  const block = authenticationBlock(user, now);
  if (block !== null) {
    // Equalize timing: verify password anyway so locked accounts do not leak via fast returns.
    await deps.hasher.verify(input.password, user.passwordHash);
    await deps.audit.append({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.failedLogin,
      targetType: 'user',
      targetId: user.id,
      after: { reason: block },
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      userAgentHash: input.meta.userAgentHash,
    });
    throw new AppError('unauthenticated', GENERIC_CREDENTIALS_ERROR);
  }

  const passwordOk = await deps.hasher.verify(input.password, user.passwordHash);
  if (!passwordOk) {
    const outcome = nextFailureState(user.failedLoginAttempts, deps.lockout, now);
    await deps.users.recordLoginFailure(user.id, {
      failedLoginAttempts: outcome.failedLoginAttempts,
      lockedUntil: outcome.lockedUntil,
    });
    await deps.audit.append({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.failedLogin,
      targetType: 'user',
      targetId: user.id,
      after: { locked: outcome.lockedNow, attempts: outcome.failedLoginAttempts },
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      userAgentHash: input.meta.userAgentHash,
    });
    throw new AppError('unauthenticated', GENERIC_CREDENTIALS_ERROR);
  }

  const token = generateSessionToken();
  const sessionId = hashSessionToken(token);
  const expiresAt = computeExpiry(now, now, deps.sessionPolicy);

  await deps.sessions.insert({
    id: sessionId,
    userId: user.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rotatedFrom: null,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });
  await deps.users.recordLoginSuccess({
    id: user.id,
    at: now,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });
  await deps.audit.append({
    actorUserId: user.id,
    action: AUDIT_ACTIONS.login,
    targetType: 'user',
    targetId: user.id,
    requestId: input.meta.requestId,
    ip: input.meta.ip,
    userAgentHash: input.meta.userAgentHash,
  });

  return { user, token, sessionId, expiresAt };
}

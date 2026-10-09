import { changePassword, type ChangePasswordInput, type ChangePasswordSuccess } from './change-password.ts';
import type { AuthDeps } from './deps.ts';
import { login, type LoginInput, type LoginSuccess } from './login.ts';
import { logout, type LogoutInput } from './logout.ts';
import { resolveSession, type ResolvedSession } from './resolve-session.ts';

export interface AuthService {
  login(input: LoginInput): Promise<LoginSuccess>;
  logout(input: LogoutInput): Promise<void>;
  changePassword(input: ChangePasswordInput): Promise<ChangePasswordSuccess>;
  resolveSession(token: string): Promise<ResolvedSession | null>;
}

export function createAuthService(deps: AuthDeps): AuthService {
  return {
    login: (input) => login(deps, input),
    logout: (input) => logout(deps, input),
    changePassword: (input) => changePassword(deps, input),
    resolveSession: (token) => resolveSession(deps, token),
  };
}

export type { AuthDeps } from './deps.ts';
export type { LoginInput, LoginSuccess } from './login.ts';
export type { LogoutInput } from './logout.ts';
export type { ChangePasswordInput, ChangePasswordSuccess } from './change-password.ts';
export type { ResolvedSession } from './resolve-session.ts';

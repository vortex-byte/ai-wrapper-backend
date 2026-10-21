import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import type { Context } from 'hono';
import type { Config } from '@/config/index.ts';
import type { AppEnv } from '../types.ts';

/** Session cookie helpers with Secure, HttpOnly, and SameSite=Lax defaults. */

function baseOptions(config: Config): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: config.SESSION_ABSOLUTE_MINUTES * 60,
  };
}

export function readSessionToken(c: Context<AppEnv>, config: Config): string | undefined {
  return getCookie(c, config.SESSION_COOKIE_NAME);
}

export function setSessionCookie(c: Context<AppEnv>, config: Config, token: string): void {
  setCookie(c, config.SESSION_COOKIE_NAME, token, baseOptions(config));
}

export function clearSessionCookie(c: Context<AppEnv>, config: Config): void {
  deleteCookie(c, config.SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
    sameSite: 'Lax',
  });
}

import { Hono } from 'hono';
import type { AppEnv } from './types.ts';

/**
 * The `/api` tree (unversioned — API_CONTRACTS §17). Feature routers are mounted here
 * as their milestones land; until then unknown paths fall through to the global 404.
 */
export function apiRouter(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  return api;
}

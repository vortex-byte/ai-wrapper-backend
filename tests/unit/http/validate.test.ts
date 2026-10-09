import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isAppError } from '@/errors.ts';
import type { AppEnv } from '@/http/types.ts';
import { MAX_JSON_BODY_BYTES, parseJsonBody } from '@/http/validate.ts';

const Body = z.object({ name: z.string().min(1) });

function app(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post('/thing', async (c) => {
    const body = await parseJsonBody(c, Body);
    return c.json({ ok: true, name: body.name });
  });
  routes.onError((error, c) => {
    const err = isAppError(error) ? error : { code: 'internal_error', status: 500 };
    return c.json({ code: err.code }, err.status as 400);
  });
  return routes;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/thing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('parseJsonBody', () => {
  it('parses a valid body', async () => {
    const res = await app().request(post(JSON.stringify({ name: 'x' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'x' });
  });

  it('rejects malformed JSON as 400 invalid_request', async () => {
    const res = await app().request(post('{ not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_request' });
  });

  it('rejects a schema failure as 400 invalid_request', async () => {
    const res = await app().request(post(JSON.stringify({ name: '' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_request' });
  });

  it('rejects an oversized body with 413 even without a truthful Content-Length', async () => {
    const huge = JSON.stringify({ name: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) });
    const res = await app().request(post(huge));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'file_too_large' });
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const res = await app().request(
      post(JSON.stringify({ name: 'x' }), {
        'Content-Length': String(MAX_JSON_BODY_BYTES + 1),
      }),
    );
    expect(res.status).toBe(413);
  });
});

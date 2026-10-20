#!/usr/bin/env bun
/**
 * Synthetic load and soak test. Staging only (spends provider tokens).
 *
 * Example:
 *   bun run scripts/load-test.ts \
 *     --base-url http://127.0.0.1:8080 \
 *     --origin https://app.corp.example \
 *     --email loadtest@corp.example \
 *     --password '…' \
 *     --concurrency 150 \
 *     --duration 1800
 */

interface Options {
  readonly baseUrl: string;
  readonly origin: string;
  readonly email: string;
  readonly password: string;
  readonly concurrency: number;
  readonly durationSeconds: number;
  readonly modelId: string | null;
  readonly streamTimeoutMs: number;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly modelId: string;
}

interface Result {
  readonly ok: boolean;
  readonly ttftMs: number | null;
  readonly totalMs: number;
  readonly status: number | null;
  readonly failure: string | null;
}

const TERMINAL_EVENTS = new Set([
  'generation.completed',
  'generation.cancelled',
  'generation.failed',
]);

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      values.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      index += 1;
    } else {
      values.set(body, '');
    }
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === '') throw new Error(`Missing required --${name}.`);
    return value;
  };

  const numeric = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive number.`);
    }
    return parsed;
  };

  const modelId = values.get('model-id');

  return {
    baseUrl: required('base-url').replace(/\/+$/, ''),
    origin: required('origin'),
    email: required('email'),
    password: required('password'),
    concurrency: Math.floor(numeric('concurrency', 150)),
    durationSeconds: Math.floor(numeric('duration', 1800)),
    modelId: modelId === undefined || modelId === '' ? null : modelId,
    streamTimeoutMs: Math.floor(numeric('stream-timeout', 120_000)),
  };
}

function headers(session: Session, options: Options, extra: Record<string, string> = {}): Headers {
  return new Headers({
    Cookie: session.cookie,
    Origin: options.origin,
    'X-CSRF-Token': session.csrfToken,
    ...extra,
  });
}

async function login(options: Options): Promise<Session> {
  const response = await fetch(`${options.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: options.origin },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!response.ok) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }

  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookieMatch = /__Host-session=([^;]*)/.exec(setCookie);
  if (cookieMatch === null) throw new Error('login response did not set a session cookie');

  const body = (await response.json()) as { data: { csrfToken: string } };
  const cookie = `__Host-session=${cookieMatch[1]}`;
  const partial = { cookie, csrfToken: body.data.csrfToken };

  return { ...partial, modelId: await pickModelId(options, partial) };
}

async function pickModelId(
  options: Options,
  session: { cookie: string; csrfToken: string },
): Promise<string> {
  if (options.modelId !== null) return options.modelId;

  const response = await fetch(`${options.baseUrl}/api/models`, {
    headers: new Headers({ Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }),
  });
  if (!response.ok) {
    throw new Error(`list models failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { items: Array<{ id: string }> } };
  const first = body.data.items[0];
  if (first === undefined) throw new Error('no visible models; pass --model-id explicitly');
  return first.id;
}

async function warnAboutLimits(session: Session, options: Options): Promise<void> {
  const response = await fetch(`${options.baseUrl}/api/me/quota`, {
    headers: new Headers({ Cookie: session.cookie }),
  });
  if (!response.ok) return;

  const body = (await response.json()) as {
    data: { limits?: { maxConcurrentGenerations?: number | null } };
  };
  const allowed = body.data.limits?.maxConcurrentGenerations ?? null;
  if (allowed !== null && allowed < options.concurrency) {
    console.warn(
      `warning: maxConcurrentGenerations is ${allowed} but concurrency is ${options.concurrency};` +
        ' raise the account quota policy or expect 429 concurrency_limit.',
    );
  }
}

async function createConversation(session: Session, options: Options): Promise<string> {
  const response = await fetch(`${options.baseUrl}/api/conversations`, {
    method: 'POST',
    headers: headers(session, options, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ modelId: session.modelId, title: 'load test' }),
  });
  if (!response.ok) {
    throw new Error(`create conversation failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function sendMessage(
  session: Session,
  options: Options,
  conversationId: string,
  turn: number,
): Promise<Result> {
  const startedAt = performance.now();
  const response = await fetch(`${options.baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: headers(session, options, {
      'Content-Type': 'application/json',
      'Idempotency-Key': `load-${crypto.randomUUID()}-${turn}`,
    }),
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
    }),
  });

  if (response.status !== 202) {
    const retryAfter = response.headers.get('retry-after');
    return {
      ok: false,
      ttftMs: null,
      totalMs: performance.now() - startedAt,
      status: response.status,
      failure:
        `send ${response.status}` + (retryAfter === null ? '' : ` (retry-after ${retryAfter}s)`),
    };
  }

  const body = (await response.json()) as {
    data: { generation: { id: string; streamUrl: string } };
  };

  return consumeStream(session, options, body.data.generation.streamUrl, startedAt);
}

async function consumeStream(
  session: Session,
  options: Options,
  streamUrl: string,
  startedAt: number,
): Promise<Result> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.streamTimeoutMs);

  try {
    const response = await fetch(`${options.baseUrl}${streamUrl}`, {
      headers: { Cookie: session.cookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      return {
        ok: false,
        ttftMs: null,
        totalMs: performance.now() - startedAt,
        status: response.status,
        failure: `stream ${response.status}`,
      };
    }

    let ttftMs: number | null = null;
    let failure: string | null = null;
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();

    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        if (read.value === undefined) continue;
        buffer += decoder.decode(read.value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim() ?? 'message';
          const data = /^data:\s*(.+)$/m.exec(frame)?.[1] ?? '';

          if (event === 'snapshot' && ttftMs === null && /"text":"[^"]+"/.test(data)) {
            ttftMs = performance.now() - startedAt;
          }
          if (event === 'error') failure = `stream error: ${data.slice(0, 200)}`;
          if (event === 'generation.failed') failure = `generation failed: ${data.slice(0, 200)}`;

          if (TERMINAL_EVENTS.has(event)) {
            await reader.cancel();
            return {
              ok: failure === null,
              ttftMs,
              totalMs: performance.now() - startedAt,
              status: response.status,
              failure,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      ok: failure === null,
      ttftMs,
      totalMs: performance.now() - startedAt,
      status: response.status,
      failure: failure ?? 'stream ended without a terminal event',
    };
  } catch (error) {
    return {
      ok: false,
      ttftMs: null,
      totalMs: performance.now() - startedAt,
      status: null,
      failure: error instanceof Error ? error.message : 'unknown stream failure',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function fmt(value: number): string {
  return value === 0 ? 'n/a' : `${Math.round(value)}ms`;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const session = await login(options);
  await warnAboutLimits(session, options);

  const deadline = Date.now() + options.durationSeconds * 1_000;
  const results: Result[] = [];
  let inFlight = 0;

  console.log(
    `load test → ${options.baseUrl} · concurrency=${options.concurrency} · duration=${options.durationSeconds}s`,
  );

  const progress = setInterval(() => {
    const failed = results.filter((result) => !result.ok).length;
    console.log(`  … ${results.length} completed, ${failed} failed, ${inFlight} in flight`);
  }, 10_000);

  const worker = async (index: number): Promise<void> => {
    let conversationId: string;
    try {
      conversationId = await createConversation(session, options);
    } catch (error) {
      results.push({
        ok: false,
        ttftMs: null,
        totalMs: 0,
        status: null,
        failure:
          `worker ${index}: ` + (error instanceof Error ? error.message : 'create failed'),
      });
      return;
    }

    let turn = 0;
    while (Date.now() < deadline) {
      inFlight += 1;
      try {
        results.push(await sendMessage(session, options, conversationId, turn));
        turn += 1;
      } catch (error) {
        results.push({
          ok: false,
          ttftMs: null,
          totalMs: 0,
          status: null,
          failure:
            `worker ${index}: ` + (error instanceof Error ? error.message : 'request failed'),
        });
      } finally {
        inFlight -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index)));
  clearInterval(progress);

  const totals = results.map((result) => result.totalMs).sort((a, b) => a - b);
  const ttfts = results
    .map((result) => result.ttftMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const failures = results.filter((result) => !result.ok);
  const statusCounts = new Map<string, number>();
  for (const result of results) {
    const key = result.status === null ? 'network' : String(result.status);
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }

  const elapsedSeconds = options.durationSeconds;
  console.log('');
  console.log('summary');
  console.log(
    `  requests:      ${results.length} (${(results.length / elapsedSeconds).toFixed(2)}/s)`,
  );
  console.log(`  failures:      ${failures.length}`);
  console.log(
    `  throughput ok: ${((results.length - failures.length) / elapsedSeconds).toFixed(2)}/s`,
  );
  console.log(`  status counts: ${JSON.stringify(Object.fromEntries(statusCounts))}`);
  console.log(
    `  total  p50/p95/p99: ${fmt(percentile(totals, 50))} / ${fmt(percentile(totals, 95))} / ${fmt(percentile(totals, 99))}`,
  );
  console.log(
    `  ttft   p50/p95/p99: ${fmt(percentile(ttfts, 50))} / ${fmt(percentile(ttfts, 95))} / ${fmt(percentile(ttfts, 99))}`,
  );

  for (const failure of failures.slice(0, 10)) {
    console.log(`  ✗ ${failure.failure ?? 'unknown failure'}`);
  }

  if (failures.length > 0) process.exitCode = 1;
}

await run();

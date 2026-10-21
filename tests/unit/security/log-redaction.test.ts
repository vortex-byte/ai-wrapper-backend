import { describe, expect, it } from 'vitest';
import { serializeLogPayload, scrubString } from '@/observability/logger.ts';

const CANARY = {
  password: 'PASSWORD-CANARY-4f1c',
  passwordHash: 'ARGON2-CANARY-a7b3',
  sessionToken: 'SESSION-CANARY-9d2e',
  csrfToken: 'CSRF-CANARY-31aa',
  apiKey: 'sk-proj-APIKEY-CANARY-77bc',
  bearer: 'Bearer BEARER-CANARY-5e6f',
  prompt: 'PROMPT-CANARY-c0ffee',
  messageText: 'MESSAGE-CANARY-deadbe',
  fileBytes: 'FILEBYTES-CANARY-123456',
  providerBody: 'PROVIDERBODY-CANARY-abcdef',
  dbPassword: 'DBPASS-CANARY-8f8f',
} as const;

function buildPayload(): Record<string, unknown> {
  const providerError = new Error(`upstream rejected key ${CANARY.apiKey} with status 401`);
  const wrapped = new Error(`generation failed: ${CANARY.bearer}`, { cause: providerError });
  (wrapped as Error & { details?: unknown }).details = {
    providerBody: CANARY.providerBody,
    status: 401,
  };
  wrapped.stack = `${wrapped.stack ?? ''}\n    at retry (provider.ts:1:1) token=${CANARY.sessionToken}`;

  return {
    requestId: 'req-1',
    generationId: 'gen-1',
    userId: 'user-1',
    inputTokens: 42,
    durationMs: 1200,
    databaseUrl: `postgres://app:${CANARY.dbPassword}@db.internal:5432/aichat`,
    headers: {
      authorization: CANARY.bearer,
      cookie: `__Host-session=${CANARY.sessionToken}`,
      'x-csrf-token': CANARY.csrfToken,
      'x-api-key': CANARY.apiKey,
    },
    user: {
      email: 'ops@corp.example',
      password: CANARY.password,
      passwordHash: CANARY.passwordHash,
    },
    request: {
      prompt: CANARY.prompt,
      messages: [{ role: 'user', content: CANARY.messageText }],
      fileBytes: CANARY.fileBytes,
      providerBody: CANARY.providerBody,
      maxTokens: 512,
    },
    err: wrapped,
  };
}

const FORBIDDEN = [
  CANARY.password,
  CANARY.passwordHash,
  CANARY.sessionToken,
  CANARY.csrfToken,
  CANARY.apiKey,
  CANARY.bearer.replace('Bearer ', ''),
  CANARY.prompt,
  CANARY.messageText,
  CANARY.fileBytes,
  CANARY.providerBody,
  CANARY.dbPassword,
];

describe('log payload security', () => {
  it('leaks none of the canaries into the serialized record', () => {
    const serialized = JSON.stringify(serializeLogPayload(buildPayload()));

    for (const canary of FORBIDDEN) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('keeps the operational metadata that incident response needs', () => {
    const serialized = serializeLogPayload(buildPayload());

    expect(serialized['requestId']).toBe('req-1');
    expect(serialized['generationId']).toBe('gen-1');
    expect(serialized['inputTokens']).toBe(42);
    expect(serialized['durationMs']).toBe(1200);

    const error = serialized['err'] as {
      name: string;
      message: string;
      stack: string;
      details: Record<string, unknown>;
      cause: { message: string };
    };
    expect(error.name).toBe('Error');
    expect(error.message).toContain('generation failed');
    expect(error.stack).toContain('retry');
    expect(error.cause.message).toContain('upstream rejected key');
    expect(error.details).toEqual({ status: 401 });
  });

  it('drops content-bearing fields entirely instead of blanking them', () => {
    const serialized = serializeLogPayload(buildPayload());
    const request = serialized['request'] as Record<string, unknown>;

    expect(Object.keys(request)).toEqual(['maxTokens']);
  });

  it('redacts secret-bearing header names', () => {
    const serialized = serializeLogPayload(buildPayload());
    const headers = serialized['headers'] as Record<string, unknown>;

    expect(headers['authorization']).toBe('[redacted]');
    expect(headers['cookie']).toBe('[redacted]');
    expect(headers['x-csrf-token']).toBe('[redacted]');
    expect(headers['x-api-key']).toBe('[redacted]');
  });

  it('redacts email properties to prevent PII exposure in operational logs', () => {
    const serialized = serializeLogPayload(buildPayload());
    const user = serialized['user'] as Record<string, unknown>;

    expect(user['email']).toBe('[redacted]');
  });

  it('scrubs credentials inside a free-text stack trace', () => {
    const stack = scrubString(
      `Error: boom\n    at login (auth.ts:9:1) password=${CANARY.password} ` +
        `token=${CANARY.sessionToken} ${CANARY.bearer}`,
    );

    expect(stack).not.toContain(CANARY.password);
    expect(stack).not.toContain(CANARY.sessionToken);
    expect(stack).not.toContain(CANARY.bearer.replace('Bearer ', ''));
    expect(stack).toContain('login (auth.ts:9:1)');
  });

  it('scrubs a connection string but preserves the host for diagnosis', () => {
    const scrubbed = scrubString(`postgres://app:${CANARY.dbPassword}@db.internal:5432/aichat`);

    expect(scrubbed).not.toContain(CANARY.dbPassword);
    expect(scrubbed).toContain('db.internal:5432/aichat');
  });
});

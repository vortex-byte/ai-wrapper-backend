import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';
import { getConfig } from '../config/index.ts';

/**
 * Structured logger. Content (message text, prompts, file bytes, provider bodies,
 * emails) must never be passed to it — see AGENTS §5 / PRD §15.10. The redaction
 * list is a second line of defence for secret-shaped keys.
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'res.headers.set-cookie',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'password_hash',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
];

export function createLogger(): Logger {
  const config = getConfig();
  const base = { app: 'ai-chat-api', env: config.NODE_ENV, role: config.ROLE };

  if (config.NODE_ENV === 'development') {
    const stream = pretty({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    });
    return pino(
      {
        level: config.LOG_LEVEL,
        base,
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      },
      stream,
    );
  }

  return pino({
    level: config.LOG_LEVEL,
    base,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

let cached: Logger | undefined;

export function getLogger(): Logger {
  if (!cached) cached = createLogger();
  return cached;
}

export function resetLoggerForTests(): void {
  cached = undefined;
}

export type { Logger };

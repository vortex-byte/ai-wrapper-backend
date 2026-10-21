import { mkdirSync } from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getConfig } from '../config/index.ts';

export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(meta: LogMeta, message: string): void;
  debug(message: string): void;
  info(meta: LogMeta, message: string): void;
  info(message: string): void;
  warn(meta: LogMeta, message: string): void;
  warn(message: string): void;
  error(meta: LogMeta, message: string): void;
  error(message: string): void;
  child(bindings: LogMeta): Logger;
}

const REDACTED = '[redacted]';

const SECRET_KEY_EXACT = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'passwordhint',
  'secret',
  'secretref',
  'sessionsecret',
  'apikey',
  'apikeyhash',
  'credential',
  'credentials',
  'privatekey',
  'sessiontoken',
  'csrftoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'token',
  'email',
  'useremail',
]);

const SECRET_KEY_SUFFIXES = [
  'password',
  'passwordhash',
  'secret',
  'apikey',
  'apikeyhash',
  'privatekey',
  'sessiontoken',
  'csrftoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'authorization',
  'cookie',
  'token',
] as const;

const CONTENT_KEY_EXACT = new Set([
  'prompt',
  'prompts',
  'messages',
  'content',
  'textcontent',
  'body',
  'rawbody',
  'providerbody',
  'responsebody',
  'filecontent',
  'filebytes',
  'completion',
  'completions',
]);

const MAX_DEPTH = 8;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SECRET_KEY_EXACT.has(normalised)) return true;
  if (normalised.startsWith('password')) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

function isContentKey(key: string): boolean {
  return CONTENT_KEY_EXACT.has(normaliseKey(key));
}

export function scrubString(input: string): string {
  return (
    input
      // postgres://user:password@host
      .replace(/\b(postgres(?:ql)?:\/\/)[^/\s@]+:[^@\s]+@/gi, `$1${REDACTED}@`)
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED)
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED)
      .replace(
        /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
        `$1=${REDACTED}`,
      )
  );
}

interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly details?: unknown;
  readonly cause?: unknown;
}

function serializeError(error: Error, seen: WeakSet<object>, depth: number): SerializedError {
  const out: {
    name: string;
    message: string;
    stack?: string;
    code?: unknown;
    status?: unknown;
    details?: unknown;
    cause?: unknown;
  } = {
    name: error.name,
    message: scrubString(error.message),
  };
  if (typeof error.stack === 'string') out.stack = scrubString(error.stack);
  const withCode = error as Error & { code?: unknown; status?: unknown; details?: unknown };
  if (withCode.code !== undefined) out.code = withCode.code;
  if (withCode.status !== undefined) out.status = withCode.status;
  if (withCode.details !== undefined && withCode.details !== null) {
    out.details = serializeValue(withCode.details, seen, depth + 1);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_DEPTH) {
    out.cause =
      cause instanceof Error
        ? serializeError(cause, seen, depth + 1)
        : serializeValue(cause, seen, depth + 1);
  }
  return out;
}

function serializeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return serializeError(value, seen, depth);
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen, depth + 1));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, item]) => [
        String(key),
        serializeValue(item, seen, depth + 1),
      ]),
    );
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => serializeValue(item, seen, depth + 1));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (isContentKey(key)) continue;
      out[key] = isSensitiveKey(key)
        ? REDACTED
        : serializeValue(source[key], seen, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function serializeLogPayload(payload: LogMeta): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (isContentKey(key)) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : serializeValue(payload[key], seen, 0);
  }
  return out;
}

const serializeFormat = winston.format((info) => {
  const raw = info as unknown as Record<string, unknown> & { level: string; message?: unknown };
  const meta: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    if (key === 'ts' || key === 'msg') continue;
    meta[key] = raw[key];
  }

  const serializedMeta = serializeLogPayload(meta);
  const timestamp =
    typeof raw['timestamp'] === 'string' ? raw['timestamp'] : new Date().toISOString();
  const message = typeof raw.message === 'string' ? scrubString(raw.message) : String(raw.message ?? '');

  const out: Record<string, unknown> = {
    ts: timestamp,
    level: raw.level,
    msg: message,
    ...serializedMeta,
  };

  // Replace every enumerable key so `format.json()` emits exactly this record.
  for (const key of Object.keys(raw)) delete raw[key];
  Object.assign(raw, out);
  return raw as unknown as winston.Logform.TransformableInfo;
});

function buildFileTransports(): winston.transport[] {
  const config = getConfig();
  const dir = path.resolve(config.LOG_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // A read-only filesystem must not stop the process; the console transport still works.
    return [];
  }

  const common = {
    dirname: dir,
    datePattern: 'YYYY-MM-DD',
    maxSize: config.LOG_MAX_SIZE,
    maxFiles: `${config.LOG_FILE_RETENTION_DAYS}d`,
    zippedArchive: true,
    auditFile: path.join(dir, '.rotation-audit.json'),
    format: winston.format.json(),
  } as const;

  return [
    new DailyRotateFile({ ...common, filename: 'app-%DATE%.log', level: 'debug' }),
    new DailyRotateFile({ ...common, filename: 'error-%DATE%.log', level: 'error' }),
  ];
}

export interface LoggerOptions {
  readonly fileLogging?: boolean | undefined;
}

function wrapWinston(logger: winston.Logger): Logger {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error') => {
    return (metaOrMessage: LogMeta | string, maybeMessage?: string): void => {
      if (typeof metaOrMessage === 'string') {
        logger.log(level, metaOrMessage);
        return;
      }
      logger.log(level, maybeMessage ?? '', metaOrMessage);
    };
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (bindings: LogMeta): Logger => wrapWinston(logger.child({ ...bindings })),
  };
}

let cached: Logger | undefined;
let cachedRaw: winston.Logger | undefined;

function buildLogger(options: LoggerOptions = {}): { logger: Logger; raw: winston.Logger } {
  const config = getConfig();
  const fileLogging = options.fileLogging ?? config.LOG_TO_FILES ?? config.NODE_ENV !== 'test';

  const transports: winston.transport[] = [
    new winston.transports.Console({ level: 'debug', format: winston.format.json() }),
  ];
  if (fileLogging) transports.push(...buildFileTransports());

  const raw = winston.createLogger({
    level: config.LOG_LEVEL,
    silent: config.LOG_LEVEL === 'silent',
    defaultMeta: { app: 'ai-chat-api', env: config.NODE_ENV, role: config.ROLE },
    format: winston.format.combine(winston.format.timestamp(), serializeFormat()),
    transports,
    exitOnError: false,
  });

  return { logger: wrapWinston(raw), raw };
}

export function getLogger(): Logger {
  if (cached === undefined) {
    const built = buildLogger();
    cached = built.logger;
    cachedRaw = built.raw;
  }
  return cached;
}

export function setLoggerForTests(logger: Logger): void {
  cached = logger;
}

export function resetLoggerForTests(): void {
  closeLogger();
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return buildLogger(options).logger;
}

export function closeLogger(): void {
  if (cachedRaw !== undefined) {
    cachedRaw.close();
    cachedRaw = undefined;
  }
  cached = undefined;
}

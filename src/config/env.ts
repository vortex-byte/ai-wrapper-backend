import { z } from 'zod';

const boolish = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off', ''].includes(v)) return false;
    }
    return value;
  }, z.boolean().default(defaultValue));

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

/** An optional string env var: an empty value means "unset", not "" (env files set `KEY=` to disable). */
const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    TEST_DATABASE_URL: optionalString,
    // Consumed **only** by the migration CLI (src/cli/migration-env.ts) — never by the server.
    MIGRATION_DATABASE_URL: optionalString,
    REDIS_URL: optionalString,
    SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().min(0).max(600).default(120),

    SESSION_COOKIE_NAME: z.literal('__Host-session').default('__Host-session'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(480),
    SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(1).default(1440),
    SESSION_SECRET: z.string().min(32),

    STORAGE_LOCAL_ROOT: z.string().min(1).default('./.var/files'),
    STORAGE_WRITE_PROVIDER: z.enum(['local']).default('local'),
    STORAGE_MIN_FREE_MIB: z.coerce.number().int().min(0).default(512),

    TOKENIZER_CACHE_DIR: z.string().min(1).default('./.cache/tokenizer'),

    QUOTA_TIMEZONE: z
      .string()
      .min(1)
      .default('Asia/Jakarta')
      .refine((tz) => {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA time zone'),
    SERVICE_BUSY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),

    MAX_ACTIVE_GENERATIONS: z.coerce.number().int().min(1).default(200),
    GENERATION_DETACH_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(60),

    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(256).default(8),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(8),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    FILE_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),
    RETAIN_EXTRACTIONS: boolish(true),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_CONTENT: boolish(false),
    LOG_DIR: z.string().min(1).default('./.var/logs'),
    LOG_FILE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    LOG_MAX_SIZE: z.string().min(1).default('20m'),
    LOG_TO_FILES: z.preprocess(
      (value) => {
        if (value === undefined) return undefined;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const v = value.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(v)) return true;
          if (['false', '0', 'no', 'off', ''].includes(v)) return false;
        }
        return value;
      },
      z.boolean().optional(),
    ),

    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,

    ALLOWED_ORIGINS: csv,

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_IP_REQUESTS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_API_IP_REQUESTS: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_USER_REQUESTS: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_LOGIN_REQUESTS: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_UPLOAD_REQUESTS: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_GENERATION_REQUESTS: z.coerce.number().int().min(1).default(20),

    CONVERSATION_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

    JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
    JOB_POLL_INTERVAL_IDLE_MS: z.coerce.number().int().min(100).default(5000),
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_ABSOLUTE_MINUTES < env.SESSION_IDLE_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_ABSOLUTE_MINUTES'],
        message: 'SESSION_ABSOLUTE_MINUTES must be >= SESSION_IDLE_MINUTES.',
      });
    }
    if (env.NODE_ENV === 'production' && env.LOG_CONTENT) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_CONTENT'],
        message: 'LOG_CONTENT must be false in production.',
      });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(source: Record<string, unknown> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }
  return parsed.data;
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function isProduction(config: Config): boolean {
  return config.NODE_ENV === 'production';
}

export function isDevelopment(config: Config): boolean {
  return config.NODE_ENV === 'development';
}

export function resetConfigForTests(): void {
  cached = undefined;
}

export function setConfigForTests(config: Config): void {
  cached = config;
}

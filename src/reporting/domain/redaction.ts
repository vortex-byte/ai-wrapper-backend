const REDACTED = '[redacted]';

const SECRET_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'temporarypassword',
  'secret',
  'secretref',
  'apikey',
  'apikeyhash',
  'authorization',
  'cookie',
  'setcookie',
  'sessiontoken',
  'csrftoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'token',
  'privatekey',
  'credential',
  'credentials',
]);

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  const k = normalise(key);
  if (SECRET_KEYS.has(k)) return true;
  if (k.startsWith('password')) return true;
  return (
    k.endsWith('password') ||
    k.endsWith('passwordhash') ||
    k.endsWith('secret') ||
    k.endsWith('apikey') ||
    k.endsWith('token') ||
    k.endsWith('authorization') ||
    k.endsWith('cookie') ||
    k.endsWith('privatekey')
  );
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(source[key], depth + 1);
  }
  return out;
}

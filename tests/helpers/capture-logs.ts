import {
  resetLoggerForTests,
  serializeLogPayload,
  setLoggerForTests,
  type Logger,
  type LogMeta,
} from '@/observability/logger.ts';

export interface CapturedRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export function captureLogs(): {
  readonly records: CapturedRecord[];
  readonly logger: Logger;
  readonly restore: () => void;
} {
  const records: CapturedRecord[] = [];

  const make = (bindings: LogMeta): Logger => {
    const push = (level: CapturedRecord['level'], metaOrMessage: LogMeta | string, message?: string) => {
      const meta: LogMeta = typeof metaOrMessage === 'string' ? {} : metaOrMessage;
      const msg = typeof metaOrMessage === 'string' ? metaOrMessage : (message ?? '');
      records.push({
        level,
        msg,
        meta: serializeLogPayload({ ...bindings, ...meta }),
      });
    };

    return {
      debug: (a: LogMeta | string, b?: string) => push('debug', a, b),
      info: (a: LogMeta | string, b?: string) => push('info', a, b),
      warn: (a: LogMeta | string, b?: string) => push('warn', a, b),
      error: (a: LogMeta | string, b?: string) => push('error', a, b),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };

  const logger = make({});
  setLoggerForTests(logger);

  return {
    records,
    logger,
    restore: () => {
      resetLoggerForTests();
    },
  };
}

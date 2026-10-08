import { createApp } from './app.ts';
import { ConfigError, getConfig } from './config/index.ts';
import { closePool } from './db/index.ts';
import { getLogger } from './observability/logger.ts';

function boot(): void {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error('Failed to load configuration:', error);
    }
    process.exit(1);
  }

  const logger = getLogger();
  const app = createApp(config);

  const server = Bun.serve({
    hostname: config.HOST,
    port: config.PORT,
    fetch: app.fetch,
    // Long-lived SSE streams need headroom; the proxy enforces the real read timeout.
    idleTimeout: 120,
  });

  logger.info(
    { host: config.HOST, port: server.port, role: config.ROLE, env: config.NODE_ENV },
    'server listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await server.stop();
      await closePool();
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

boot();

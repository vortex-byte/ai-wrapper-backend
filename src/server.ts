import { createApp } from './app.ts';
import { ConfigError, getConfig } from './config/index.ts';
import { closePool } from './db/index.ts';
import { setShuttingDown } from './health/readyz.ts';
import { getLogger } from './observability/logger.ts';
import { createServices } from './services.ts';

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
  const services = createServices(config);

  let server: ReturnType<typeof Bun.serve> | null = null;

  if (config.ROLE === 'api' || config.ROLE === 'all') {
    const app = createApp(config, services);
    server = Bun.serve({
      hostname: config.HOST,
      port: config.PORT,
      fetch: app.fetch,
      idleTimeout: 120,
    });

    logger.info(
      { host: config.HOST, port: server.port, role: config.ROLE, env: config.NODE_ENV },
      'server listening',
    );
  }

  if (config.ROLE === 'worker' || config.ROLE === 'all') {
    services.jobRunner.start();
    services.scheduler.start();
    logger.info({ role: config.ROLE, env: config.NODE_ENV }, 'worker started');
  }

  /**
   * Graceful shutdown:
   * 1. Fail readiness.
   * 2. Close admission gate for new requests.
   * 3. Stop accepting new HTTP connections.
   * 4. Allow in-flight requests and streams to drain.
   * 5. Cancel remaining active runs if drain timeout expires.
   * 6. Close database pool and exit.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    setShuttingDown(true);
    services.orchestrator.isDraining = true;

    const drainMs = config.SHUTDOWN_DRAIN_SECONDS * 1_000;
    logger.info({ signal, drainSeconds: config.SHUTDOWN_DRAIN_SECONDS }, 'shutting down');

    if (server) {
      server.stop();
    }

    const deadline = Date.now() + drainMs;
    while (
      ((server?.pendingRequests ?? 0) > 0 || services.orchestrator.activeCount > 0) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(50);
    }

    if (services.orchestrator.activeCount > 0) {
      logger.warn(
        { activeRuns: services.orchestrator.activeCount },
        'drain window elapsed; aborting active generation runs with shutdown',
      );
      await services.orchestrator.shutdown(0);
    }

    if (server && server.pendingRequests > 0) {
      logger.warn(
        { pendingRequests: server.pendingRequests },
        'drain window elapsed; forcing connection close',
      );
      server.stop(true);
    }

    if (config.ROLE === 'worker' || config.ROLE === 'all') {
      services.scheduler.stop();
      try {
        await services.jobRunner.stop();
      } catch (error) {
        logger.error({ err: error }, 'error stopping job runner');
      }
    }

    try {
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

import { createApp } from './app.ts';
import { ConfigError, getConfig } from './config/index.ts';
import { closePool } from './db/index.ts';
import { setShuttingDown } from './health/readyz.ts';
import { closeLogger, getLogger } from './observability/logger.ts';
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
    services.jobRunner.start(config.JOB_POLL_INTERVAL_MS, config.JOB_POLL_INTERVAL_IDLE_MS);
    services.scheduler.start();
    logger.info({ role: config.ROLE, env: config.NODE_ENV }, 'worker started');
  }

  /** Graceful shutdown: fails readiness, drains active work, and releases resources. */
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    setShuttingDown(true);
    services.orchestrator.isDraining = true;

    const drainMs = config.SHUTDOWN_DRAIN_SECONDS * 1_000;
    logger.info({ signal, drainSeconds: config.SHUTDOWN_DRAIN_SECONDS }, 'shutting down');

    // Allow probes observing /readyz (poll interval ~2s) to observe the transition
    // before stopping the HTTP listener.
    if (server) {
      await Bun.sleep(2000);
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
      try {
        await services.scheduler.stop();
      } catch (error) {
        logger.error({ err: error }, 'error stopping scheduler');
      }
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

    try {
      closeLogger();
    } catch {
      // Best-effort logger flush
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A fatal fault must not kill the process with a raw crash: log through winston, drain, and
  // exit non-zero so systemd restarts the unit.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

boot();

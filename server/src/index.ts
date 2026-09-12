import { createServer } from 'node:http';
import { env } from './config.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime/gateway.js';

/**
 * Process entry point.
 *
 * Two things here matter for production:
 *
 *   1. The database connects BEFORE the port opens. A server that accepts
 *      traffic it cannot serve produces confusing 500s during a deploy.
 *
 *   2. Shutdown is graceful. On SIGTERM the listener stops accepting new
 *      connections, in-flight requests finish, then the database closes.
 *      Without this, every deploy drops whatever was in progress — which
 *      during a live session means losing answers.
 */

async function main(): Promise<void> {
  await connectDb();

  const app = createApp();
  const server = createServer(app);

  // Attached before the port opens, so a client that connects the instant
  // the server is up finds the socket handler already listening.
  const io = attachRealtime(server);

  // Slightly above a typical 60s load-balancer idle timeout, so the balancer
  // closes idle connections rather than the app racing it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise<void>((resolve) => {
    server.listen(env.PORT, resolve);
  });

  logger.info(
    { port: env.PORT, env: env.NODE_ENV, pid: process.pid },
    `Server listening on http://localhost:${String(env.PORT)}`,
  );

  /* ---------------- graceful shutdown ---------------- */

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Hard deadline. If something hangs, exit anyway rather than leaving
    // the process wedged and the deploy stuck.
    const forceExit = setTimeout(() => {
      logger.error('Shutdown took too long, forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    // Sockets first: a phone told the session is closing can show that,
    // where a socket killed with the process just looks like a crash.
    void io.close();

    server.close(() => {
      void disconnectDb()
        .then(() => {
          logger.info('Shutdown complete');
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'Error during shutdown');
          process.exit(1);
        });
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  // A crash with an unknown state is worse than a restart. Log, then let
  // the supervisor bring us back clean.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});

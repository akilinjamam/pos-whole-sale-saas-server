import type { Server } from 'node:http';

import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';

let server: Server | undefined;

/**
 * Shut down in the right order: stop accepting connections, let in-flight requests finish,
 * then close the database. Closing Mongo first would fail every request already in progress.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('HTTP server closed');
    }
    await disconnectDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(
      { port: config.port, env: config.env },
      `API listening on http://localhost:${config.port}/api/v1`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});

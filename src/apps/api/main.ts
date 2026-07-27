import { buildApp } from './app.js';
import { PostgresCatalog } from '../../modules/catalog/infrastructure/postgres-catalog.js';
import { BullMqHoldExpirationScheduler } from '../../modules/reservations/infrastructure/bullmq-hold-expiration.js';
import { PostgresReservations } from '../../modules/reservations/infrastructure/postgres-reservations.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { LiveHealthDependencies } from '../../shared/health/live-dependencies.js';
import { createRedisClient } from '../../shared/redis/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabasePool(config);
  const redis = createRedisClient(config);
  const expirationScheduler = new BullMqHoldExpirationScheduler(config);
  const app = buildApp({
    config,
    dependencies: new LiveHealthDependencies(database, redis),
    catalog: new PostgresCatalog(database),
    reservations: new PostgresReservations(database, expirationScheduler),
  });
  app.addHook('onClose', async () => expirationScheduler.close());
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'graceful shutdown started');

    const timeout = setTimeout(() => {
      app.log.fatal({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    timeout.unref();

    try {
      await app.close();
      clearTimeout(timeout);
      app.log.info('graceful shutdown completed');
    } catch (error) {
      app.log.error({ err: error }, 'graceful shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

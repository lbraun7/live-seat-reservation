import { buildApp } from './app.js';
import { PostgresCatalog } from '../../modules/catalog/infrastructure/postgres-catalog.js';
import { BullMqHoldExpirationScheduler } from '../../modules/reservations/infrastructure/bullmq-hold-expiration.js';
import { PostgresReservations } from '../../modules/reservations/infrastructure/postgres-reservations.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { LiveHealthDependencies } from '../../shared/health/live-dependencies.js';
import { createRedisClient } from '../../shared/redis/client.js';
import { AdmissionTokenSigner } from '../../modules/waiting-room/application/admission-token.js';
import { RedisWaitingRoom } from '../../modules/waiting-room/infrastructure/redis-waiting-room.js';
import { FakePaymentProvider } from '../../modules/checkout/infrastructure/fake-payment-provider.js';
import { PostgresCheckout } from '../../modules/checkout/infrastructure/postgres-checkout.js';
import { ServiceMetrics } from '../../shared/observability/metrics.js';
import { startTracing } from '../../shared/observability/tracing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const tracing = startTracing('api', config.otelExporterOtlpEndpoint);
  const metrics = new ServiceMetrics('api');
  const database = createDatabasePool(config);
  metrics.observePool(database);
  metrics.observeActiveHolds(database);
  const redis = createRedisClient(config);
  const expirationScheduler = new BullMqHoldExpirationScheduler(config);
  const waitingRoom = new RedisWaitingRoom(
    redis,
    new AdmissionTokenSigner(config.admissionTokenSecret, config.admissionTokenTtlSeconds),
    {
      sessionTtlSeconds: config.waitingRoomSessionTtlSeconds,
      admissionTtlSeconds: config.admissionTokenTtlSeconds,
      rateLimitWindowSeconds: config.rateLimitWindowSeconds,
      rateLimitPerUser: config.rateLimitPerUser,
      rateLimitPerSession: config.rateLimitPerSession,
      rateLimitPerIp: config.rateLimitPerIp,
    },
  );
  const app = buildApp({
    config,
    dependencies: new LiveHealthDependencies(database, redis),
    catalog: new PostgresCatalog(database),
    reservations: new PostgresReservations(
      database,
      expirationScheduler,
      config.maxActiveHoldsPerUser,
    ),
    waitingRoom,
    checkout: new PostgresCheckout(database, new FakePaymentProvider()),
    metrics,
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
      metrics.close();
      await tracing?.shutdown();
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

import { OutboxRelay } from '../../modules/outbox/application/outbox-relay.js';
import { RedisOutboxPublisher } from '../../modules/outbox/infrastructure/redis-outbox-publisher.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { createRedisClient } from '../../shared/redis/client.js';
import { ServiceMetrics, startMetricsServer } from '../../shared/observability/metrics.js';
import { startTracing } from '../../shared/observability/tracing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const tracing = startTracing('outbox-relay', config.otelExporterOtlpEndpoint);
  const serviceMetrics = new ServiceMetrics('outbox-relay');
  const database = createDatabasePool(config);
  serviceMetrics.observePool(database);
  const redis = createRedisClient(config);
  await redis.connect();
  const relay = new OutboxRelay(database, new RedisOutboxPublisher(redis));
  let shuttingDown = false;
  const metricsServer = await startMetricsServer(
    serviceMetrics,
    config.host,
    config.outboxMetricsPort,
    {
      isDraining: () => shuttingDown,
      check: async () => {
        const [databaseHealth, redisHealth] = await Promise.allSettled([
          database.query('SELECT 1'),
          redis.ping(),
        ]);
        return {
          database: databaseHealth.status === 'fulfilled',
          redis: redisHealth.status === 'fulfilled',
        };
      },
    },
  );
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let processed = 0;
      do {
        processed = await relay.relayBatch(config.outboxRelayBatchSize);
      } while (processed === config.outboxRelayBatchSize);
      const metrics = await relay.metrics();
      serviceMetrics.outboxPending.set(metrics.pendingCount);
      serviceMetrics.outboxOldestAge.set(metrics.oldestPendingAgeMs / 1000);
      const archived = await relay.archivePublished(
        config.outboxRetentionDays,
        config.outboxRelayBatchSize,
      );
      if (processed > 0 || metrics.pendingCount > 0 || archived > 0) {
        log('info', 'outbox relay cycle completed', { processed, ...metrics, archived });
      }
    } catch (error) {
      log('error', 'outbox relay cycle failed', { error: errorMessage(error) });
    } finally {
      running = false;
    }
  };

  await tick();
  const interval = setInterval(() => void tick(), config.outboxRelayIntervalMs);
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    log('info', 'outbox relay graceful shutdown started', { signal });
    while (running) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise<void>((resolve, reject) => {
      metricsServer.close((error) => (error ? reject(error) : resolve()));
    });
    redis.disconnect();
    await database.end();
    serviceMetrics.close();
    await tracing?.shutdown();
    log('info', 'outbox relay graceful shutdown completed', { signal });
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  log('info', 'outbox relay started', {
    channel: 'reservation.domain-events',
    intervalMs: config.outboxRelayIntervalMs,
    batchSize: config.outboxRelayBatchSize,
    metricsPort: config.outboxMetricsPort,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(level: 'info' | 'error', message: string, fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, time: new Date().toISOString(), message, ...fields }));
}

main().catch((error: unknown) => {
  log('error', 'outbox relay startup failed', { error: errorMessage(error) });
  process.exitCode = 1;
});

import { OutboxRelay } from '../../modules/outbox/application/outbox-relay.js';
import { RedisOutboxPublisher } from '../../modules/outbox/infrastructure/redis-outbox-publisher.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { createRedisClient } from '../../shared/redis/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabasePool(config);
  const redis = createRedisClient(config);
  await redis.connect();
  const relay = new OutboxRelay(database, new RedisOutboxPublisher(redis));
  const metricsServer = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void relay
      .metrics()
      .then((metrics) => {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(
          [
            '# HELP outbox_pending_events Events waiting to be published.',
            '# TYPE outbox_pending_events gauge',
            `outbox_pending_events ${String(metrics.pendingCount)}`,
            '# HELP outbox_oldest_pending_age_seconds Age of the oldest pending event.',
            '# TYPE outbox_oldest_pending_age_seconds gauge',
            `outbox_oldest_pending_age_seconds ${String(metrics.oldestPendingAgeMs / 1000)}`,
            '',
          ].join('\n'),
        );
      })
      .catch((error: unknown) => {
        response.writeHead(503).end(errorMessage(error));
      });
  });
  await new Promise<void>((resolve, reject) => {
    metricsServer.once('error', reject);
    metricsServer.listen(config.outboxMetricsPort, config.host, resolve);
  });
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
  let shuttingDown = false;
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
import { createServer } from 'node:http';

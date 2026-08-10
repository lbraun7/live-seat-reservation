import { AdmissionController } from '../../modules/waiting-room/application/admission-controller.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { createRedisClient } from '../../shared/redis/client.js';
import { ServiceMetrics, startMetricsServer } from '../../shared/observability/metrics.js';
import { startTracing } from '../../shared/observability/tracing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const tracing = startTracing('admission-controller', config.otelExporterOtlpEndpoint);
  const metrics = new ServiceMetrics('admission-controller');
  const database = createDatabasePool(config);
  metrics.observePool(database);
  const redis = createRedisClient(config);
  if (redis.status === 'wait') await redis.connect();
  const controller = new AdmissionController(
    redis,
    database,
    {
      eventId: config.waitingRoomEventId,
      intervalMs: config.admissionControllerIntervalMs,
      batchSize: config.admissionBatchSize,
      maxActiveAdmissions: config.maxActiveAdmissions,
      admissionTtlSeconds: config.admissionTokenTtlSeconds,
      saturationLatencyMs: config.admissionSaturationLatencyMs,
      maxExpirationBacklog: config.admissionMaxExpirationBacklog,
    },
    metrics,
  );
  let closing = false;
  const metricsServer = await startMetricsServer(metrics, config.host, config.metricsPort ?? 9464, {
    isDraining: () => closing,
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
  });
  controller.start();

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await controller.close();
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    await redis.quit().catch(() => redis.disconnect());
    await database.end();
    metrics.close();
    await tracing?.shutdown();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  console.info(
    JSON.stringify({ eventId: config.waitingRoomEventId, message: 'admission controller started' }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

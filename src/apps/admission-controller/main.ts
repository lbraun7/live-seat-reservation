import { AdmissionController } from '../../modules/waiting-room/application/admission-controller.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';
import { createRedisClient } from '../../shared/redis/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabasePool(config);
  const redis = createRedisClient(config);
  if (redis.status === 'wait') await redis.connect();
  const controller = new AdmissionController(redis, database, {
    eventId: config.waitingRoomEventId,
    intervalMs: config.admissionControllerIntervalMs,
    batchSize: config.admissionBatchSize,
    maxActiveAdmissions: config.maxActiveAdmissions,
    admissionTtlSeconds: config.admissionTokenTtlSeconds,
    saturationLatencyMs: config.admissionSaturationLatencyMs,
    maxExpirationBacklog: config.admissionMaxExpirationBacklog,
  });
  controller.start();

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await controller.close();
    await redis.quit().catch(() => redis.disconnect());
    await database.end();
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

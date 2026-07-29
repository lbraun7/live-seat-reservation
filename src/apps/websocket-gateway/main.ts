import { loadConfig } from '../../shared/config/config.js';
import { createRedisClient } from '../../shared/redis/client.js';
import { RealtimeGateway } from '../../modules/realtime/application/realtime-gateway.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const subscriber = createRedisClient(config);
  const gateway = new RealtimeGateway(subscriber, {
    host: config.host,
    port: config.websocketPort,
    heartbeatIntervalMs: config.websocketHeartbeatIntervalMs,
    maxMessageBytes: config.websocketMaxMessageBytes,
    maxMessagesPerMinute: config.websocketMaxMessagesPerMinute,
    maxBufferedBytes: config.websocketMaxBufferedBytes,
    drainTimeoutMs: config.shutdownTimeoutMs,
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(JSON.stringify({ signal, message: 'websocket gateway draining' }));
    await gateway.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await gateway.start();
  console.info(
    JSON.stringify({ port: config.websocketPort, message: 'websocket gateway listening' }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

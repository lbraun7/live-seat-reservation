import { Redis } from 'ioredis';

import type { AppConfig } from '../config/config.js';

export function createRedisClient(config: AppConfig): Redis {
  return new Redis(config.redisUrl, {
    connectTimeout: config.redisConnectionTimeoutMs,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

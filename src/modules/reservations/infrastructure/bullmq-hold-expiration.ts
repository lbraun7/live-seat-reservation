import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { AppConfig } from '../../../shared/config/config.js';
import {
  HOLD_EXPIRATION_QUEUE,
  type HoldExpirationJob,
  type HoldExpirationScheduler,
} from '../application/hold-expiration.js';

export class BullMqHoldExpirationScheduler implements HoldExpirationScheduler {
  private readonly connection: Redis;
  private readonly queue: Queue<HoldExpirationJob>;

  constructor(config: AppConfig) {
    this.connection = new Redis(config.redisUrl, {
      connectTimeout: config.redisConnectionTimeoutMs,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.queue = new Queue<HoldExpirationJob>(HOLD_EXPIRATION_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: config.holdExpirationJobAttempts,
        backoff: {
          type: 'exponential',
          delay: config.holdExpirationBackoffMs,
          jitter: 0.5,
        },
        removeOnComplete: { age: 3600, count: 10_000 },
        removeOnFail: false,
      },
    });
  }

  async schedule(job: HoldExpirationJob): Promise<void> {
    const delay = Math.max(0, Date.parse(job.expectedExpiresAt) - Date.now());
    await this.queue.add('expire-hold', job, {
      delay,
      jobId: job.holdId,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}

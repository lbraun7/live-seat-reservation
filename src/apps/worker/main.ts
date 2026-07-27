import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import {
  HOLD_EXPIRATION_DEAD_LETTER_QUEUE,
  HOLD_EXPIRATION_QUEUE,
  type HoldExpirationJob,
} from '../../modules/reservations/application/hold-expiration.js';
import { PostgresHoldExpirationStore } from '../../modules/reservations/infrastructure/postgres-hold-expiration.js';
import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabasePool(config);
  const store = new PostgresHoldExpirationStore(database);
  const connection = new Redis(config.redisUrl, {
    connectTimeout: config.redisConnectionTimeoutMs,
    maxRetriesPerRequest: null,
  });
  const deadLetters = new Queue(HOLD_EXPIRATION_DEAD_LETTER_QUEUE, { connection });
  const worker = new Worker<HoldExpirationJob>(
    HOLD_EXPIRATION_QUEUE,
    async (job) => {
      const result = await store.expireHold(job.data);
      log('info', 'hold expiration job processed', {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        ...result,
      });
      return result;
    },
    { connection },
  );

  worker.on('failed', (job, error) => {
    if (!job || !isLastAttempt(job)) return;
    void deadLetters
      .add(
        'failed-expiration',
        {
          ...job.data,
          originalJobId: job.id,
          attemptsMade: job.attemptsMade,
          failedReason: error.message,
          failedAt: new Date().toISOString(),
        },
        { jobId: job.data.holdId, removeOnComplete: false, removeOnFail: false },
      )
      .then(() => {
        log('error', 'hold expiration moved to dead-letter queue', {
          jobId: job.id,
          holdId: job.data.holdId,
          error: error.message,
        });
      })
      .catch((deadLetterError: unknown) => {
        log('error', 'failed to persist hold expiration dead letter', {
          jobId: job.id,
          error: errorMessage(deadLetterError),
        });
      });
  });
  worker.on('error', (error) =>
    log('error', 'hold expiration worker error', { error: error.message }),
  );

  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      let total = 0;
      let maximumDelayMs = 0;
      for (;;) {
        const expired = await store.reconcileExpiredHolds(config.holdReconcilerBatchSize);
        total += expired.length;
        maximumDelayMs = Math.max(maximumDelayMs, ...expired.map(({ delayMs }) => delayMs ?? 0));
        if (expired.length < config.holdReconcilerBatchSize) break;
      }
      if (total > 0) {
        log('info', 'expired holds reconciled', { count: total, maximumDelayMs });
      }
    } catch (error) {
      log('error', 'hold expiration reconciliation failed', { error: errorMessage(error) });
    } finally {
      reconciling = false;
    }
  };
  await reconcile();
  const interval = setInterval(() => void reconcile(), config.holdReconcilerIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    log('info', 'worker graceful shutdown started', { signal });
    await worker.close();
    await deadLetters.close();
    connection.disconnect();
    await database.end();
    log('info', 'worker graceful shutdown completed', { signal });
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  log('info', 'hold expiration worker started', {
    queue: HOLD_EXPIRATION_QUEUE,
    reconcilerIntervalMs: config.holdReconcilerIntervalMs,
    reconcilerBatchSize: config.holdReconcilerBatchSize,
  });
}

function isLastAttempt(job: Job): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(level: 'info' | 'error', message: string, fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, time: new Date().toISOString(), message, ...fields }));
}

main().catch((error: unknown) => {
  log('error', 'worker startup failed', { error: errorMessage(error) });
  process.exitCode = 1;
});

import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AdmissionController } from '../../src/modules/waiting-room/application/admission-controller.js';
import { AdmissionTokenSigner } from '../../src/modules/waiting-room/application/admission-token.js';
import { RedisWaitingRoom } from '../../src/modules/waiting-room/infrastructure/redis-waiting-room.js';

const redisUrl = process.env.TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;
const eventId = randomUUID();
const userId = randomUUID();

describeWithRedis('waiting room through Redis', () => {
  const redis = new Redis(redisUrl ?? '', { maxRetriesPerRequest: 1 });
  const signer = new AdmissionTokenSigner('integration-secret-at-least-thirty-two-chars', 60);
  const waitingRoom = new RedisWaitingRoom(redis, signer, {
    sessionTtlSeconds: 1,
    admissionTtlSeconds: 60,
    rateLimitWindowSeconds: 1,
    rateLimitPerUser: 100,
    rateLimitPerSession: 100,
    rateLimitPerIp: 100,
  });
  const database = {
    waitingCount: 0,
    query: () => Promise.resolve({ rows: [], rowCount: 1 }),
  } as unknown as Pool;

  beforeEach(async () => {
    const keys = await redis.keys(`waiting-room:*${eventId}*`);
    const rateKeys = await redis.keys('waiting-room:rate:*');
    if (keys.length + rateKeys.length > 0) await redis.del(...keys, ...rateKeys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('admits in deterministic order and enforces the global capacity across controllers', async () => {
    const first = await waitingRoom.join({ eventId, userId, ip: '127.0.0.1' });
    const second = await waitingRoom.join({ eventId, userId: randomUUID(), ip: '127.0.0.2' });
    await redis.zadd(
      `waiting-room:event:${eventId}:queue`,
      1,
      first.sessionId,
      1,
      second.sessionId,
    );
    const options = {
      eventId,
      intervalMs: 1000,
      batchSize: 10,
      maxActiveAdmissions: 1,
      admissionTtlSeconds: 60,
      saturationLatencyMs: 100,
    };
    const controllers = [
      new AdmissionController(redis, database, options),
      new AdmissionController(redis, database, options),
    ];
    const admitted = (await Promise.all(controllers.map((item) => item.admitOnce()))).flat();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toBe([first.sessionId, second.sessionId].sort()[0]);
    expect(await redis.zcard(`waiting-room:event:${eventId}:admitted`)).toBe(1);
  });

  it('rejects a mismatched token and prevents reuse by another idempotency key', async () => {
    const session = await waitingRoom.join({ eventId, userId, ip: '127.0.0.1' });
    const controller = new AdmissionController(redis, database, {
      eventId,
      intervalMs: 1000,
      batchSize: 1,
      maxActiveAdmissions: 1,
      admissionTtlSeconds: 60,
      saturationLatencyMs: 100,
    });
    await controller.admitOnce();
    const admission = await waitingRoom.heartbeat({
      eventId,
      sessionId: session.sessionId,
      userId,
      ip: '127.0.0.1',
    });
    if (!('token' in admission)) throw new Error('session should be admitted');

    await expect(
      waitingRoom.consumeAdmission({
        token: admission.token,
        eventId: randomUUID(),
        userId,
        ip: '127.0.0.1',
        idempotencyKey: 'first',
      }),
    ).rejects.toMatchObject({ code: 'ADMISSION_TOKEN_MISMATCH' });
    await waitingRoom.consumeAdmission({
      token: admission.token,
      eventId,
      userId,
      ip: '127.0.0.1',
      idempotencyKey: 'first',
    });
    await expect(
      waitingRoom.consumeAdmission({
        token: admission.token,
        eventId,
        userId,
        ip: '127.0.0.1',
        idempotencyKey: 'second',
      }),
    ).rejects.toMatchObject({ code: 'ADMISSION_TOKEN_CONSUMED' });
  });

  it('removes an abandoned session after its heartbeat TTL', async () => {
    const session = await waitingRoom.join({ eventId, userId, ip: '127.0.0.1' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const controller = new AdmissionController(redis, database, {
      eventId,
      intervalMs: 50,
      batchSize: 1,
      maxActiveAdmissions: 1,
      admissionTtlSeconds: 60,
      saturationLatencyMs: 100,
    });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await controller.close();
    expect(await redis.zrank(`waiting-room:event:${eventId}:queue`, session.sessionId)).toBeNull();
  });
});

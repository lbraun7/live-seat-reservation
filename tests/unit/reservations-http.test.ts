import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/apps/api/app.js';
import type { Reservations } from '../../src/modules/reservations/domain/reservations.js';
import type { AppConfig } from '../../src/shared/config/config.js';
import {
  WaitingRoomError,
  type WaitingRoom,
} from '../../src/modules/waiting-room/domain/waiting-room.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  redisUrl: 'redis://unused',
  databaseConnectionTimeoutMs: 100,
  redisConnectionTimeoutMs: 100,
  shutdownTimeoutMs: 1000,
  holdExpirationJobAttempts: 5,
  holdExpirationBackoffMs: 1000,
  holdReconcilerIntervalMs: 5000,
  holdReconcilerBatchSize: 100,
  outboxRelayIntervalMs: 500,
  outboxRelayBatchSize: 100,
  outboxRetentionDays: 7,
  outboxMetricsPort: 9464,
  websocketPort: 3001,
  websocketHeartbeatIntervalMs: 30_000,
  websocketMaxMessageBytes: 4096,
  websocketMaxMessagesPerMinute: 120,
  websocketMaxBufferedBytes: 1_048_576,
  admissionTokenSecret: 'test-secret-at-least-thirty-two-characters',
  admissionTokenTtlSeconds: 60,
  waitingRoomSessionTtlSeconds: 90,
  admissionControllerIntervalMs: 1000,
  admissionBatchSize: 25,
  maxActiveAdmissions: 100,
  admissionSaturationLatencyMs: 100,
  admissionMaxExpirationBacklog: 10_000,
  waitingRoomEventId: '10000000-0000-4000-8000-000000000001',
  rateLimitWindowSeconds: 60,
  rateLimitPerUser: 30,
  rateLimitPerSession: 120,
  rateLimitPerIp: 300,
  maxActiveHoldsPerUser: 4,
  paymentWebhookSecret: 'test-payment-secret-at-least-thirty-two-characters',
};
const dependencies = {
  check: vi.fn().mockResolvedValue({ database: true, redis: true }),
  close: vi.fn().mockResolvedValue(undefined),
};
const eventId = '10000000-0000-4000-8000-000000000001';
const seatId = '30000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
const holdId = '50000000-0000-4000-8000-000000000001';
const hold = {
  id: holdId,
  eventId,
  seatId,
  userId,
  status: 'ACTIVE' as const,
  expiresAt: '2026-07-24T15:05:00.000Z',
  createdAt: '2026-07-24T15:00:00.000Z',
};

function service(overrides: Partial<Reservations> = {}): Reservations {
  return {
    createHold: vi.fn().mockResolvedValue({ statusCode: 201, body: hold }),
    getHold: vi.fn().mockResolvedValue(hold),
    cancelHold: vi
      .fn()
      .mockResolvedValue({ statusCode: 200, body: { ...hold, status: 'CANCELLED' } }),
    confirmHold: vi
      .fn()
      .mockResolvedValue({ statusCode: 200, body: { ...hold, status: 'CONFIRMED' } }),
    ...overrides,
  };
}

describe('reservation HTTP contracts', () => {
  it('creates a hold with identity, idempotency and a deterministic request hash', async () => {
    const createHold = vi.fn<Reservations['createHold']>().mockResolvedValue({
      statusCode: 201,
      body: hold,
    });
    const reservations = service({ createHold });
    const app = buildApp({ config, dependencies, reservations });

    const response = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/holds`,
      headers: { 'x-user-id': userId, 'idempotency-key': 'checkout-1' },
      payload: { seatId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(hold);
    expect(createHold).toHaveBeenCalledOnce();
    const command = createHold.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      eventId,
      seatId,
      userId,
      idempotencyKey: 'checkout-1',
    });
    expect(command?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    await app.close();
  });

  it('requires user and idempotency headers for commands', async () => {
    const app = buildApp({ config, dependencies, reservations: service() });
    const response = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/holds`,
      payload: { seatId },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('marks a replay in the response', async () => {
    const app = buildApp({
      config,
      dependencies,
      reservations: service({
        confirmHold: vi.fn().mockResolvedValue({
          statusCode: 200,
          body: { ...hold, status: 'CONFIRMED' },
          replayed: true,
        }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/holds/${holdId}/confirm`,
      headers: { 'x-user-id': userId, 'idempotency-key': 'confirm-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['idempotency-replayed']).toBe('true');
    await app.close();
  });

  it('does not create a hold when the client has not been admitted', async () => {
    const createHold = vi.fn<Reservations['createHold']>();
    const waitingRoom: WaitingRoom = {
      join: vi.fn(),
      heartbeat: vi.fn(),
      position: vi.fn(),
      consumeAdmission: vi
        .fn()
        .mockRejectedValue(
          new WaitingRoomError('ADMISSION_TOKEN_INVALID', 'Admission token is invalid', 403),
        ),
    };
    const app = buildApp({
      config,
      dependencies,
      reservations: service({ createHold }),
      waitingRoom,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/holds`,
      headers: {
        'x-user-id': userId,
        'idempotency-key': 'not-admitted',
        'x-admission-token': 'invalid-token',
      },
      payload: { seatId },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ADMISSION_TOKEN_INVALID' });
    expect(createHold).not.toHaveBeenCalled();
    await app.close();
  });
});

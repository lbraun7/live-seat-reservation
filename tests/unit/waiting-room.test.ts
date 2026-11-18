import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { AdmissionTokenSigner } from '../../src/modules/waiting-room/application/admission-token.js';
import type { WaitingRoom } from '../../src/modules/waiting-room/domain/waiting-room.js';
import { registerWaitingRoomRoutes } from '../../src/modules/waiting-room/transport/http.js';

const eventId = '10000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
const sessionId = '50000000-0000-4000-8000-000000000001';

describe('admission token', () => {
  const signer = new AdmissionTokenSigner('test-secret-at-least-thirty-two-characters', 60);

  it('binds a short-lived signed token to the user, event and session', () => {
    const issued = signer.issue({ eventId, userId, sessionId }, 1_000_000);
    expect(signer.verify(issued.token, 1_001_000)).toMatchObject({
      eventId,
      userId,
      sessionId,
    });
  });

  it('rejects tampering and expiration', () => {
    const issued = signer.issue({ eventId, userId, sessionId }, 1_000_000);
    expect(() => signer.verify(`${issued.token}x`, 1_001_000)).toThrow();
    expect(() => signer.verify(issued.token, 1_061_000)).toThrow();
  });
});

describe('waiting-room HTTP contract', () => {
  it('returns 201 when a session joins the queue', async () => {
    const waitingRoom: WaitingRoom = {
      join: vi.fn().mockResolvedValue({
        sessionId,
        eventId,
        userId,
        joinedAt: '2026-11-18T12:00:00.000Z',
        position: 1,
      }),
      heartbeat: vi.fn(),
      position: vi.fn(),
      consumeAdmission: vi.fn(),
    };
    const app = Fastify();
    registerWaitingRoomRoutes(app, waitingRoom);

    const response = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/waiting-room`,
      headers: { 'x-user-id': userId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ sessionId, eventId, userId, position: 1 });
    await app.close();
  });
});

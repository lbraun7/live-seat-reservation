import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { type WaitingRoom, WaitingRoomError } from '../domain/waiting-room.js';

const Uuid = Type.String({ format: 'uuid' });
const EventParams = Type.Object({ eventId: Uuid });
const SessionParams = Type.Object({ eventId: Uuid, sessionId: Uuid });
const Headers = Type.Object({ 'x-user-id': Uuid });
const WaitingResponse = Type.Object({
  sessionId: Uuid,
  eventId: Uuid,
  userId: Uuid,
  joinedAt: Type.String({ format: 'date-time' }),
  position: Type.Integer({ minimum: 0 }),
});
const AdmissionResponse = Type.Object({
  token: Type.String(),
  expiresAt: Type.String({ format: 'date-time' }),
});
const ErrorResponse = Type.Object({ code: Type.String(), message: Type.String() });

type EventParamsType = Static<typeof EventParams>;
type SessionParamsType = Static<typeof SessionParams>;
type HeadersType = Static<typeof Headers>;

export function registerWaitingRoomRoutes(app: FastifyInstance, waitingRoom: WaitingRoom): void {
  app.post<{ Params: EventParamsType; Headers: HeadersType }>('/events/:eventId/waiting-room', {
    schema: {
      params: EventParams,
      headers: Headers,
      response: {
        201: WaitingResponse,
        429: ErrorResponse,
      },
    },
    handler: async (request, reply) =>
      handle(reply, () =>
        waitingRoom.join({
          eventId: request.params.eventId,
          userId: request.headers['x-user-id'],
          ip: request.ip,
        }),
      ),
  });

  app.post<{ Params: SessionParamsType; Headers: HeadersType }>(
    '/events/:eventId/waiting-room/:sessionId/heartbeat',
    {
      schema: {
        params: SessionParams,
        headers: Headers,
        response: {
          200: Type.Union([WaitingResponse, AdmissionResponse]),
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
      handler: async (request, reply) =>
        handle(reply, () =>
          waitingRoom.heartbeat({
            eventId: request.params.eventId,
            sessionId: request.params.sessionId,
            userId: request.headers['x-user-id'],
            ip: request.ip,
          }),
        ),
    },
  );

  app.get<{ Params: SessionParamsType; Headers: HeadersType }>(
    '/events/:eventId/waiting-room/:sessionId',
    {
      schema: {
        params: SessionParams,
        headers: Headers,
        response: {
          200: Type.Union([WaitingResponse, AdmissionResponse]),
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
      handler: async (request, reply) =>
        handle(reply, () =>
          waitingRoom.position(
            request.params.eventId,
            request.params.sessionId,
            request.headers['x-user-id'],
          ),
        ),
    },
  );
}

async function handle(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WaitingRoomError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    throw error;
  }
}

import { createHash } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  ReservationError,
  type ReservationResult,
  type Reservations,
} from '../domain/reservations.js';
import type { WaitingRoom } from '../../waiting-room/domain/waiting-room.js';

const Uuid = Type.String({ format: 'uuid' });
const IdentityHeaders = Type.Object({
  'x-user-id': Uuid,
});
const CommandHeaders = Type.Intersect([
  IdentityHeaders,
  Type.Object({
    'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
  }),
]);
const CreateHoldHeaders = Type.Intersect([
  CommandHeaders,
  Type.Object({
    'x-admission-token': Type.String({ minLength: 1, maxLength: 2048 }),
  }),
]);
const HoldParams = Type.Object({ holdId: Uuid });
const EventParams = Type.Object({ eventId: Uuid });
const CreateHoldBody = Type.Object({ seatId: Uuid }, { additionalProperties: false });
const HoldResponse = Type.Object({
  id: Uuid,
  eventId: Uuid,
  seatId: Uuid,
  userId: Uuid,
  status: Type.Union([
    Type.Literal('ACTIVE'),
    Type.Literal('CONFIRMED'),
    Type.Literal('CANCELLED'),
    Type.Literal('EXPIRED'),
  ]),
  expiresAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
  orderId: Type.Optional(Uuid),
});
const ErrorResponse = Type.Object({ code: Type.String(), message: Type.String() });

type IdentityHeadersType = Static<typeof IdentityHeaders>;
type CommandHeadersType = Static<typeof CommandHeaders>;
type CreateHoldHeadersType = Static<typeof CreateHoldHeaders>;
type HoldParamsType = Static<typeof HoldParams>;
type EventParamsType = Static<typeof EventParams>;
type CreateHoldBodyType = Static<typeof CreateHoldBody>;

const errorResponses = {
  400: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  429: ErrorResponse,
  503: ErrorResponse,
};

export function registerReservationRoutes(
  app: FastifyInstance,
  reservations: Reservations,
  waitingRoom?: WaitingRoom,
): void {
  app.post<{
    Params: EventParamsType;
    Headers: CreateHoldHeadersType;
    Body: CreateHoldBodyType;
  }>('/events/:eventId/holds', {
    schema: {
      params: EventParams,
      headers: waitingRoom ? CreateHoldHeaders : CommandHeaders,
      body: CreateHoldBody,
      response: { 201: HoldResponse, ...errorResponses },
    },
    handler: async (request, reply) =>
      handle(reply, async () => {
        if (waitingRoom) {
          await waitingRoom.consumeAdmission({
            token: request.headers['x-admission-token'],
            eventId: request.params.eventId,
            userId: request.headers['x-user-id'],
            ip: request.ip,
            idempotencyKey: request.headers['idempotency-key'],
          });
        }
        return reservations.createHold({
          eventId: request.params.eventId,
          seatId: request.body.seatId,
          userId: request.headers['x-user-id'],
          idempotencyKey: request.headers['idempotency-key'],
          requestHash: hashRequest({
            eventId: request.params.eventId,
            seatId: request.body.seatId,
          }),
        });
      }),
  });

  app.get<{ Params: HoldParamsType; Headers: IdentityHeadersType }>('/holds/:holdId', {
    schema: {
      params: HoldParams,
      headers: IdentityHeaders,
      response: { 200: HoldResponse, ...errorResponses },
    },
    handler: async (request, reply) => {
      try {
        return await reply.send(
          await reservations.getHold(request.params.holdId, request.headers['x-user-id']),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  });

  for (const action of ['cancel', 'confirm'] as const) {
    app.post<{
      Params: HoldParamsType;
      Headers: CommandHeadersType;
    }>(`/holds/:holdId/${action}`, {
      schema: {
        params: HoldParams,
        headers: CommandHeaders,
        response: { 200: HoldResponse, ...errorResponses },
      },
      handler: async (request, reply) =>
        handle(reply, () =>
          reservations[action === 'cancel' ? 'cancelHold' : 'confirmHold']({
            holdId: request.params.holdId,
            userId: request.headers['x-user-id'],
            idempotencyKey: request.headers['idempotency-key'],
            requestHash: hashRequest({ holdId: request.params.holdId, action }),
          }),
        ),
    });
  }
}

async function handle(
  reply: FastifyReply,
  operation: () => Promise<ReservationResult>,
): Promise<unknown> {
  try {
    const result = await operation();
    if (result.replayed) void reply.header('idempotency-replayed', 'true');
    return await reply.code(result.statusCode).send(result.body);
  } catch (error) {
    return sendError(reply, error);
  }
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof ReservationError) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    'code' in error &&
    error instanceof Error
  ) {
    return reply
      .code(error.statusCode as number)
      .send({ code: error.code as string, message: error.message });
  }
  throw error;
}

function hashRequest(payload: Record<string, string>): string {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${key}:${payload[key] ?? ''}`)
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

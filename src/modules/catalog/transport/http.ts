import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { Catalog } from '../domain/catalog.js';

const Uuid = Type.String({ format: 'uuid' });
const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
});
const Section = Type.Object({
  id: Uuid,
  name: Type.String(),
  displayOrder: Type.Integer(),
  seatCount: Type.Integer(),
});
const EventResponse = Type.Object({
  id: Uuid,
  name: Type.String(),
  venueName: Type.String(),
  startsAt: Type.String({ format: 'date-time' }),
  salesStartAt: Type.String({ format: 'date-time' }),
  mapVersion: Type.Integer({ minimum: 1 }),
  sections: Type.Array(Section),
});
const Seat = Type.Object({
  id: Uuid,
  sectionId: Uuid,
  label: Type.String(),
  row: Type.String(),
  number: Type.Integer(),
  status: Type.Union([Type.Literal('AVAILABLE'), Type.Literal('HELD'), Type.Literal('SOLD')]),
  version: Type.Integer({ minimum: 1 }),
});
const SnapshotResponse = Type.Object({
  eventId: Uuid,
  version: Type.Integer({ minimum: 1 }),
  sectionId: Uuid,
  seats: Type.Array(Seat),
  page: Type.Object({
    limit: Type.Integer(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
});
const EventParams = Type.Object({ eventId: Uuid });
const SnapshotQuery = Type.Object({
  sectionId: Uuid,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

type EventParamsType = Static<typeof EventParams>;
type SnapshotQueryType = Static<typeof SnapshotQuery>;

export function registerCatalogRoutes(app: FastifyInstance, catalog: Catalog): void {
  app.get<{ Params: EventParamsType }>('/events/:eventId', {
    schema: {
      params: EventParams,
      response: { 200: EventResponse, 404: ErrorResponse },
    },
    handler: async (request, reply) => {
      const event = await catalog.findEvent(request.params.eventId);
      if (!event) {
        return reply.code(404).send({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
      }
      return reply.send(event);
    },
  });

  app.get<{ Params: EventParamsType; Querystring: SnapshotQueryType }>('/events/:eventId/seats', {
    schema: {
      params: EventParams,
      querystring: SnapshotQuery,
      response: { 200: SnapshotResponse, 400: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (request, reply) => {
      try {
        const snapshot = await catalog.getSeatMapSnapshot(request.params.eventId, {
          sectionId: request.query.sectionId,
          limit: request.query.limit ?? 200,
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        });
        if (!snapshot) {
          return await reply
            .code(404)
            .send({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
        }
        return await reply.send(snapshot);
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid cursor') {
          return reply.code(400).send({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
        }
        throw error;
      }
    },
  });
}

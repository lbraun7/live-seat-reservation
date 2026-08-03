import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Catalog } from '../../modules/catalog/domain/catalog.js';
import { registerCatalogRoutes } from '../../modules/catalog/transport/http.js';
import type { Reservations } from '../../modules/reservations/domain/reservations.js';
import { registerReservationRoutes } from '../../modules/reservations/transport/http.js';
import type { AppConfig } from '../../shared/config/config.js';
import type { HealthDependencies } from '../../shared/health/dependencies.js';
import type { WaitingRoom } from '../../modules/waiting-room/domain/waiting-room.js';
import { registerWaitingRoomRoutes } from '../../modules/waiting-room/transport/http.js';
import type { Checkout } from '../../modules/checkout/domain/checkout.js';
import { registerCheckoutRoutes } from '../../modules/checkout/transport/http.js';
import type { ServiceMetrics } from '../../shared/observability/metrics.js';

const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('unavailable')]),
});

const ReadinessResponse = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  checks: Type.Object({ database: Type.Boolean(), redis: Type.Boolean() }),
});

export interface BuildAppOptions {
  config: AppConfig;
  dependencies: HealthDependencies;
  catalog?: Catalog;
  reservations?: Reservations;
  waitingRoom?: WaitingRoom;
  checkout?: Checkout;
  metrics?: ServiceMetrics;
}

export function buildApp({
  config,
  dependencies,
  catalog,
  reservations,
  waitingRoom,
  checkout,
  metrics,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    requestIdHeader: 'x-correlation-id',
    genReqId: (request) => {
      const supplied = request.headers['x-correlation-id'];
      return typeof supplied === 'string' && supplied.length <= 128 ? supplied : randomUUID();
    },
  });

  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('x-correlation-id', request.id);
    done();
  });

  if (metrics) {
    app.addHook('onRequest', (request, _reply, done) => {
      (request as typeof request & { metricsStartedAt?: bigint }).metricsStartedAt =
        process.hrtime.bigint();
      done();
    });
    app.addHook('onResponse', (request, reply, done) => {
      const started = (request as typeof request & { metricsStartedAt?: bigint }).metricsStartedAt;
      const route = request.routeOptions.url ?? 'unmatched';
      if (started)
        metrics.httpDuration.observe(
          { method: request.method, route, status_code: String(reply.statusCode) },
          Number(process.hrtime.bigint() - started) / 1e9,
        );
      if (route === '/events/:eventId/holds' && request.method === 'POST') {
        const success = reply.statusCode === 201;
        metrics.holdAttempts.inc({ result: success ? 'success' : 'rejected' });
        if (reply.statusCode === 409) metrics.holdConflicts.inc({ code: 'conflict' });
      }
      done();
    });
    app.get('/metrics', async (_request, reply) => {
      return reply
        .header('content-type', metrics.registry.contentType)
        .send(await metrics.content());
    });
  }

  app.get('/health/live', {
    schema: { response: { 200: HealthResponse } },
    handler: () => ({ status: 'ok' as const }),
  });

  app.get('/health/ready', {
    schema: { response: { 200: ReadinessResponse, 503: ReadinessResponse } },
    handler: async (_request, reply) => {
      const checks = await dependencies.check();
      const ready = checks.database && checks.redis;
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks,
      });
    },
  });

  if (catalog) registerCatalogRoutes(app, catalog);
  if (waitingRoom) registerWaitingRoomRoutes(app, waitingRoom);
  if (reservations) registerReservationRoutes(app, reservations, waitingRoom);
  if (checkout) registerCheckoutRoutes(app, checkout, config.paymentWebhookSecret);

  app.addHook('onClose', async () => dependencies.close());
  return app;
}

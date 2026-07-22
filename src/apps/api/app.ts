import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../../shared/config/config.js';
import type { HealthDependencies } from '../../shared/health/dependencies.js';

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
}

export function buildApp({ config, dependencies }: BuildAppOptions): FastifyInstance {
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

  app.addHook('onClose', async () => dependencies.close());
  return app;
}

import { createHash } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { verifyPaymentWebhook } from '../application/webhook-signature.js';
import { CheckoutError, type Checkout, type CheckoutResult } from '../domain/checkout.js';

const Uuid = Type.String({ format: 'uuid' });
const Params = Type.Object({ id: Uuid });
const HoldParams = Type.Object({ holdId: Uuid });
const Identity = Type.Object({ 'x-user-id': Uuid });
const Command = Type.Intersect([
  Identity,
  Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }) }),
]);
const WebhookHeaders = Type.Object({
  'x-payment-signature': Type.String({ pattern: '^[a-fA-F0-9]{64}$' }),
});
const WebhookBody = Type.Object(
  {
    eventId: Uuid,
    providerPaymentId: Uuid,
    type: Type.Union([Type.Literal('payment.succeeded'), Type.Literal('payment.failed')]),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
const PaymentResponse = Type.Object({
  id: Uuid,
  providerPaymentId: Uuid,
  holdId: Uuid,
  userId: Uuid,
  status: Type.Union(
    ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LATE_SUCCEEDED'].map((value) =>
      Type.Literal(value),
    ),
  ),
  createdAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Optional(Type.String({ format: 'date-time' })),
  orderId: Type.Optional(Uuid),
});
const ErrorResponse = Type.Object({ code: Type.String(), message: Type.String() });
type ParamsT = Static<typeof Params>;
type HoldParamsT = Static<typeof HoldParams>;
type IdentityT = Static<typeof Identity>;
type CommandT = Static<typeof Command>;
type WebhookHeadersT = Static<typeof WebhookHeaders>;
type WebhookBodyT = Static<typeof WebhookBody>;

export function registerCheckoutRoutes(
  app: FastifyInstance,
  checkout: Checkout,
  webhookSecret: string,
): void {
  app.post<{ Params: HoldParamsT; Headers: CommandT }>('/holds/:holdId/checkout', {
    schema: {
      params: HoldParams,
      headers: Command,
      response: {
        200: PaymentResponse,
        201: PaymentResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
    handler: async (request, reply) =>
      handle(reply, () =>
        checkout.start({
          holdId: request.params.holdId,
          userId: request.headers['x-user-id'],
          idempotencyKey: request.headers['idempotency-key'],
          requestHash: hash(request.params.holdId),
        }),
      ),
  });
  app.get<{ Params: ParamsT; Headers: IdentityT }>('/payments/:id', {
    schema: {
      params: Params,
      headers: Identity,
      response: { 200: PaymentResponse, 403: ErrorResponse, 404: ErrorResponse },
    },
    handler: async (request, reply) => {
      try {
        return await checkout.get(request.params.id, request.headers['x-user-id']);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  });
  app.post<{ Params: ParamsT; Headers: CommandT }>('/payments/:id/cancel', {
    schema: {
      params: Params,
      headers: Command,
      response: {
        200: PaymentResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
    handler: async (request, reply) =>
      handle(reply, () =>
        checkout.cancel({
          paymentId: request.params.id,
          userId: request.headers['x-user-id'],
          idempotencyKey: request.headers['idempotency-key'],
          requestHash: hash(`${request.params.id}:cancel`),
        }),
      ),
  });
  app.post<{ Headers: WebhookHeadersT; Body: WebhookBodyT }>('/webhooks/fake-payment', {
    schema: {
      headers: WebhookHeaders,
      body: WebhookBody,
      response: {
        202: Type.Object({ duplicate: Type.Boolean(), outcome: Type.String() }),
        401: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request, reply) => {
      if (
        !verifyPaymentWebhook(request.body, request.headers['x-payment-signature'], webhookSecret)
      )
        return reply
          .code(401)
          .send({ code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature is invalid' });
      try {
        return await reply.code(202).send(await checkout.handleWebhook(request.body));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  });
}

async function handle(
  reply: FastifyReply,
  operation: () => Promise<CheckoutResult>,
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
  if (error instanceof CheckoutError)
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  throw error;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

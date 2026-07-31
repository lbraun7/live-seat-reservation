import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PaymentWebhook } from '../domain/checkout.js';

export function webhookPayload(event: PaymentWebhook): string {
  return `${event.eventId}.${event.providerPaymentId}.${event.type}.${event.occurredAt}`;
}

export function signPaymentWebhook(event: PaymentWebhook, secret: string): string {
  return createHmac('sha256', secret).update(webhookPayload(event)).digest('hex');
}

export function verifyPaymentWebhook(
  event: PaymentWebhook,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signPaymentWebhook(event, secret), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

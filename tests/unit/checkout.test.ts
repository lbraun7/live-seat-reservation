import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  signPaymentWebhook,
  verifyPaymentWebhook,
} from '../../src/modules/checkout/application/webhook-signature.js';

describe('payment webhook signatures', () => {
  it('accepts only an untampered event signed with the configured secret', () => {
    const event = {
      eventId: randomUUID(),
      providerPaymentId: randomUUID(),
      type: 'payment.succeeded' as const,
      occurredAt: new Date().toISOString(),
    };
    const secret = 'test-payment-secret-at-least-thirty-two-characters';
    const signature = signPaymentWebhook(event, secret);
    expect(verifyPaymentWebhook(event, signature, secret)).toBe(true);
    expect(verifyPaymentWebhook({ ...event, type: 'payment.failed' }, signature, secret)).toBe(
      false,
    );
    expect(verifyPaymentWebhook(event, '00', secret)).toBe(false);
  });
});
